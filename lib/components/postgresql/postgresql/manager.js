import Events from "#core/events";
import LifecycleManager from "#core/threads/lifecycle-manager";
import PostgresqlInstance from "./instance.js";
import { ASYNCHRONOUS_NAME, PRIMARY_NAME, SYNCHRONOUS_NAME } from "./utils.js";

const UPDATE_RETRY_INTERVAL = 10_000,

    // lsn of the cleanly stopped primary is the location of its shutdown checkpoint record, lsn of the caught up standby is the end of the same record,
    // so the standby is always ahead of the primary by the size of this record (~100 bytes)
    LSN_TOLERANCE = 1024n;

export default class PostgresqlManager {
    #postgresql;
    #app;
    #lifecycleManager;
    #mutex;
    #isManager = false;
    #abortController;
    #managerAbortController;
    #instances = new Map();
    #serviceDiscoveryEvents;
    #updating = false;
    #updatePending = false;
    #updateTimer;

    constructor ( postgresql ) {
        this.#postgresql = postgresql;
        this.#app = postgresql.app;

        this.#mutex = this.#app.cluster.mutexes.get( "postgresql-manager" );

        this.#serviceDiscoveryEvents = new Events().link( this.#app.cluster.serviceDiscovery );

        this.#lifecycleManager = new LifecycleManager( {
            "onStart": this.#start.bind( this ),
            "onStop": this.#stop.bind( this ),
        } );
    }

    // properties
    get app () {
        return this.#app;
    }

    get postgresql () {
        return this.#postgresql;
    }

    get isManager () {
        return this.#isManager;
    }

    // public
    async start () {
        return this.#lifecycleManager.start();
    }

    async stop () {
        return this.#lifecycleManager.stop();
    }

    // XXX implement
    // return cluster status, number of unstances by roles as object
    getStatus () {}

    // private
    async #start ( signal ) {
        this.#selectManager();

        return result( 200 );
    }

    async #stop () {
        this.#abortController?.abort();

        return result( 200 );
    }

    async #selectManager () {
        this.#abortController = new AbortController();

        const signal = this.#abortController.signal;

        while ( true ) {
            if ( !this.#lifecycleManager.canBeginActivity ) break;

            if ( signal.aborted ) break;

            const locked = await this.#mutex.lock( {
                signal,
            } );

            if ( !locked ) continue;

            this.#startManager();

            await this.#mutex.wait( { signal } );

            this.#stopManager();
        }

        this.#abortController = null;

        this.#stopManager();
    }

    // XXX
    async #startManager () {
        console.log( "[postgresql] This instance is selected as PostgreSQL manager" );

        this.#isManager = true;
        this.#managerAbortController = new AbortController();

        this.#app.cluster.serviceDiscovery.addService( "postgresql-manager-rpc", this.app.components.get( "privateHttpServer" ).port, {
            "pathname": this.app.rpc.config.frontend.location,
        } );

        this.#serviceDiscoveryEvents.on( `add/${ this.#app.env.name }/postgresql-instance-rpc`, this.#addInstance.bind( this ) );
        this.#serviceDiscoveryEvents.on( `delete/${ this.#app.env.name }/postgresql-instance-rpc`, this.#deleteInstance.bind( this ) );

        const services = await this.#app.cluster.serviceDiscovery.getServices( {
            "appName": this.#app.env.name,
            "serviceName": "postgresql-instance-rpc",
        } );

        // manager role was lost while the services were loading
        if ( !this.#isManager ) return;

        for ( const service of services ) {
            this.#addInstance( service, { "update": false } );
        }

        this.#onUpdate();
    }

    #stopManager () {
        this.#isManager = false;

        clearTimeout( this.#updateTimer );
        this.#updateTimer = null;

        this.#managerAbortController?.abort();
        this.#managerAbortController = null;

        this.#serviceDiscoveryEvents.offAll();

        this.#app.cluster.serviceDiscovery.deleteService( "postgresql-manager-rpc" );

        // instances are tracked only by the active manager
        for ( const instance of this.#instances.values() ) {
            instance.api.forceDestroy();
        }

        this.#instances.clear();
    }

    #addInstance ( { uri, hostname }, { update = true } = {} ) {
        if ( this.#instances.get( uri ) ) return;

        const instance = new PostgresqlInstance( uri );

        this.#instances.set( uri, instance );

        if ( update ) {
            this.#onUpdate();
        }
    }

    #deleteInstance ( { uri } ) {
        const instance = this.#instances.get( uri );

        if ( !instance ) return;

        this.#instances.delete( uri );

        instance.api.forceDestroy();

        this.#onUpdate();
    }

    // called on cluster instances updated
    // updates are serialized: if an update is requested while another one is running, it will be repeated after the running one is finished
    async #onUpdate () {
        if ( !this.#isManager ) return;

        if ( this.#updating ) {
            this.#updatePending = true;

            return;
        }

        this.#updating = true;

        const signal = this.#managerAbortController.signal;

        try {
            do {
                this.#updatePending = false;

                clearTimeout( this.#updateTimer );
                this.#updateTimer = null;

                const ok = await this.#updateCluster( signal );

                if ( signal.aborted ) break;

                if ( !ok ) this.#scheduleUpdate();
            } while ( this.#updatePending && !signal.aborted );
        }
        catch ( e ) {
            console.log( `[postgresql] Cluster update error: ${ e.message }` );

            this.#updatePending = false;

            this.#scheduleUpdate();
        }
        finally {
            this.#updating = false;
        }

        // update was requested by the next manager term
        if ( this.#updatePending && this.#isManager ) this.#onUpdate();
    }

    #scheduleUpdate () {
        if ( !this.#isManager || this.#updateTimer ) return;

        this.#updateTimer = setTimeout( () => {
            this.#updateTimer = null;

            this.#onUpdate();
        }, UPDATE_RETRY_INTERVAL );
    }

    // status is unknown (instance is unreachable) or instance is busy
    #isUnsettled ( instances ) {
        return instances.some( instance => !instance.status || instance.busy );
    }

    // returns true, if the cluster is in the desired state, false - if the update must be repeated later
    async #updateCluster ( signal ) {
        const instances = this.#instances
            .values()
            .toArray()
            .sort( ( a, b ) => a.hostname.localeCompare( b.hostname ) );

        if ( !instances.length ) return true;

        // refresh statuses
        await Promise.all( instances.map( instance => instance.getStatus() ) );

        if ( signal.aborted ) return true;

        let unsettled = this.#isUnsettled( instances );

        const primaries = instances.filter( instance => instance.status === "started" && instance.role === PRIMARY_NAME );

        let primary = primaries[ 0 ];

        // more than one primary is running, the cluster state can not be trusted, stop all instances and configure the cluster from scratch
        if ( primaries.length > 1 ) {
            console.log( `[postgresql] More than one primary is running: ${ primaries.map( instance => instance.hostname ).join( ", " ) }, stopping all instances` );

            await Promise.all( instances.filter( instance => instance.status === "started" ).map( instance => instance.stop() ) );

            if ( signal.aborted ) return true;

            // refresh statuses after stop
            await Promise.all( instances.map( instance => instance.getStatus() ) );

            if ( signal.aborted ) return true;

            unsettled = this.#isUnsettled( instances );

            primary = null;
        }

        // there is no primary
        if ( !primary ) {

            // do not select the primary until the state of all instances is known, otherwise the stale instance can be selected
            if ( unsettled ) return false;

            primary = await this.#selectPrimary( instances, signal );

            if ( !primary || signal.aborted ) return false;
        }

        const ok = await this.#updateStandbys( instances, primary, signal );

        return ok && !unsettled;
    }

    // stops all instances, recovers them, selects the most advanced one and starts it as a primary
    async #selectPrimary ( instances, signal ) {

        // running standby has no timeline and lsn, they are known only after the recovery
        await Promise.all( instances.filter( instance => instance.status === "started" ).map( instance => instance.stop() ) );

        if ( signal.aborted ) return;

        await Promise.all( instances.filter( instance => instance.status === "stopped" && instance.timeline === null ).map( instance => instance.recover() ) );

        if ( signal.aborted ) return;

        const candidates = instances.filter( instance => instance.status === "stopped" && instance.timeline !== null );

        // all instances must be recovered
        if ( candidates.length !== instances.length ) {
            console.log( "[postgresql] Unable to select primary, not all instances are recovered" );

            return;
        }

        const best = this.#findBestCandidate( candidates );

        console.log( `[postgresql] Starting primary on ${ best.hostname } (timeline: ${ best.timeline }, lsn: ${ best.lsn || "-" }, promote: ${ best.standby })` );

        const res = await best.start( PRIMARY_NAME );

        if ( !res.ok ) {
            console.log( `[postgresql] Unable to start primary on ${ best.hostname }: ${ res.statusText }` );

            return;
        }

        return best;
    }

    async #updateStandbys ( instances, primary, signal ) {
        const numberOfSynchronousStandbys = this.#postgresql.config.replication.numberOfSynchronousStandbys ?? 0;

        const standbys = instances.filter( instance => instance !== primary && !instance.busy ),
            running = standbys.filter( instance => instance.status === "started" ),
            stopped = standbys.filter( instance => instance.status === "stopped" );

        // number of synchronous standbys, that are not running yet
        let missing = Math.max( 0, numberOfSynchronousStandbys - running.filter( instance => instance.role === SYNCHRONOUS_NAME ).length );

        const tasks = [];

        for ( const instance of stopped ) {
            let role;

            if ( missing > 0 ) {
                role = SYNCHRONOUS_NAME;

                missing--;
            }
            else {
                role = ASYNCHRONOUS_NAME;
            }

            tasks.push( this.#startStandby( instance, role, primary, signal ) );
        }

        // not enough synchronous standbys, the primary will block commits, so restart asynchronous standbys as synchronous
        for ( const instance of running.filter( instance => instance.role === ASYNCHRONOUS_NAME ).slice( 0, missing ) ) {
            tasks.push( this.#startStandby( instance, SYNCHRONOUS_NAME, primary, signal ) );
        }

        const results = await Promise.all( tasks );

        return results.every( res => res.ok );
    }

    async #startStandby ( instance, role, primary, signal ) {
        let res;

        // role can be changed only by restart
        if ( instance.status === "started" ) {
            res = await instance.stop();
            if ( !res.ok ) return res;
        }

        // recover and replay local wal, timeline and lsn are known after this
        if ( instance.timeline === null ) {
            res = await instance.recover();
            if ( !res.ok ) return res;
        }

        if ( signal.aborted ) return result( [ 500, "Aborted" ] );

        console.log( `[postgresql] Starting ${ role } on ${ instance.hostname }, primary: ${ primary.hostname }` );

        res = await instance.start( role, {
            "replicationHostname": primary.hostname,
        } );

        if ( !res.ok ) {
            console.log( `[postgresql] Unable to start ${ role } on ${ instance.hostname }: ${ res.statusText }` );
        }

        return res;
    }

    // the highest timeline wins, then the highest lsn
    // promotion of a standby (instance with standby.signal) creates a new timeline, so an instance without standby.signal is preferred, if it is on the same timeline and does not lag behind the best one
    #findBestCandidate ( candidates ) {
        let best;

        for ( const instance of candidates ) {
            if ( !best || this.#compareInstances( instance, best ) > 0 ) best = instance;
        }

        if ( !best.standby ) return best;

        const bestLsn = this.#parseLsn( best.lsn );

        let primary;

        for ( const instance of candidates ) {
            if ( instance.standby || instance.timeline !== best.timeline ) continue;

            if ( this.#parseLsn( instance.lsn ) + LSN_TOLERANCE < bestLsn ) continue;

            if ( !primary || this.#compareInstances( instance, primary ) > 0 ) primary = instance;
        }

        return primary ?? best;
    }

    #compareInstances ( a, b ) {
        if ( a.timeline !== b.timeline ) return a.timeline - b.timeline;

        const lsnA = this.#parseLsn( a.lsn ),
            lsnB = this.#parseLsn( b.lsn );

        if ( lsnA === lsnB ) return 0;

        return lsnA > lsnB
            ? 1
            : -1;
    }

    // "0/3000060" -> bigint
    #parseLsn ( lsn ) {
        if ( !lsn ) return 0n;

        const [ high, low ] = lsn.split( "/", 2 );

        return ( BigInt( `0x${ high }` ) << 32n ) | BigInt( `0x${ low }` );
    }
}
