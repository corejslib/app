import Events from "#core/events";
import LifecycleManager from "#core/threads/lifecycle-manager";
import PostgresqlInstance from "./instance.js";
import { ASYNCHRONOUS_NAME, PRIMARY_NAME, SYNCHRONOUS_NAME } from "./utils.js";

const UPDATE_RETRY_INTERVAL = 10_000;

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

    // returns the cluster status as it was seen by the last cluster update, the status is known only by the active manager
    // status: "unavailable" - there is no running primary, "degraded" - the cluster works, but not in the desired state, "ok" - the cluster is in the desired state
    getStatus () {
        if ( !this.#isManager ) return result( [ 500, "This instance is not a PostgreSQL manager" ] );

        const instances = this.#instances.values().toArray(),
            roles = {
                [ PRIMARY_NAME ]: 0,
                [ SYNCHRONOUS_NAME ]: 0,
                [ ASYNCHRONOUS_NAME ]: 0,
            };

        let started = 0,
            stopped = 0,
            unknown = 0,
            busy = 0;

        for ( const instance of instances ) {
            if ( instance.busy ) busy++;

            if ( !instance.status ) {
                unknown++;
            }
            else if ( instance.status === "started" ) {
                started++;

                if ( roles[ instance.role ] !== undefined ) roles[ instance.role ]++;
            }
            else if ( instance.status === "stopped" ) {
                stopped++;
            }
        }

        const numberOfSynchronousStandbys = this.#postgresql.config.replication.numberOfSynchronousStandbys ?? 0;

        let status;

        if ( !roles[ PRIMARY_NAME ] ) {
            status = "unavailable";
        }
        else if ( roles[ PRIMARY_NAME ] > 1 || roles[ SYNCHRONOUS_NAME ] < numberOfSynchronousStandbys || started < instances.length ) {
            status = "degraded";
        }
        else {
            status = "ok";
        }

        return result( 200, {
            status,
            "updating": this.#updating,
            "instances": {
                "total": instances.length,
                started,
                stopped,
                unknown,
                busy,
            },
            roles,
        } );
    }

    // private
    async #start ( signal ) {
        this.#selectManager();

        console.log( "[postgresql] Manager started, waiting for the manager role" );

        return result( 200 );
    }

    async #stop () {
        console.log( "[postgresql] Manager is stopping" );

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

            console.log( "[postgresql] Manager lock acquired" );

            this.#startManager();

            await this.#mutex.wait( { signal } );

            console.log( "[postgresql] Manager lock released" );

            this.#stopManager();
        }

        this.#abortController = null;

        this.#stopManager();
    }

    async #startManager () {
        console.log( "[postgresql] This instance is selected as PostgreSQL manager" );

        this.#isManager = true;
        this.#managerAbortController = new AbortController();

        this.#app.cluster.serviceDiscovery.addService( "postgresql-manager-rpc", this.app.components.get( "privateHttpServer" ).port, {
            "pathname": this.app.rpc.config.frontend.location,
        } );

        console.log( "[postgresql] Service postgresql-manager-rpc registered" );

        this.#serviceDiscoveryEvents.on( `add/${ this.#app.env.name }/postgresql-instance-rpc`, this.#addInstance.bind( this ) );
        this.#serviceDiscoveryEvents.on( `delete/${ this.#app.env.name }/postgresql-instance-rpc`, this.#deleteInstance.bind( this ) );

        console.log( "[postgresql] Subscribed to service discovery events" );

        const services = await this.#app.cluster.serviceDiscovery.getServices( {
            "appName": this.#app.env.name,
            "serviceName": "postgresql-instance-rpc",
        } );

        console.log( `[postgresql] Loaded instance services: ${ services.length }` );

        // manager role was lost while the services were loading
        if ( !this.#isManager ) {
            console.log( "[postgresql] Manager role was lost while the services were loading" );

            return;
        }

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

        const total = this.#instances.size;

        this.#instances.clear();

        console.log( `[postgresql] This instance is no longer PostgreSQL manager, instances released: ${ total }` );
    }

    #addInstance ( { uri, hostname }, { update = true } = {} ) {
        if ( this.#instances.get( uri ) ) return;

        const instance = new PostgresqlInstance( uri );

        this.#instances.set( uri, instance );

        console.log( `[postgresql] Instance added: ${ uri }` );

        if ( update ) {
            this.#onUpdate();
        }
    }

    #deleteInstance ( { uri } ) {
        const instance = this.#instances.get( uri );

        if ( !instance ) return;

        this.#instances.delete( uri );

        instance.api.forceDestroy();

        console.log( `[postgresql] Instance deleted: ${ uri }` );

        this.#onUpdate();
    }

    // called on cluster instances updated
    // updates are serialized: if an update is requested while another one is running, it will be repeated after the running one is finished
    async #onUpdate () {
        if ( !this.#isManager ) return;

        if ( this.#updating ) {
            this.#updatePending = true;

            console.log( "[postgresql] Cluster update is already running, the next one is pending" );

            return;
        }

        this.#updating = true;

        const signal = this.#managerAbortController.signal;

        try {
            do {
                this.#updatePending = false;

                clearTimeout( this.#updateTimer );
                this.#updateTimer = null;

                console.log( "[postgresql] Cluster update started" );

                const ok = await this.#updateCluster( signal );

                if ( signal.aborted ) {
                    console.log( "[postgresql] Cluster update aborted" );

                    break;
                }

                console.log( `[postgresql] Cluster update finished: ${ ok
                    ? "cluster is in the desired state"
                    : "update must be repeated" }` );

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

        console.log( `[postgresql] Next cluster update scheduled in ${ UPDATE_RETRY_INTERVAL / 1000 }s` );
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

        if ( !instances.length ) {
            console.log( "[postgresql] There are no instances to update" );

            return true;
        }

        // refresh statuses
        await Promise.all( instances.map( instance => this.#refreshStatus( instance ) ) );

        if ( signal.aborted ) return true;

        let unsettled = this.#isUnsettled( instances );

        const primaries = instances.filter( instance => instance.status === "started" && instance.role === PRIMARY_NAME );

        let primary = primaries[ 0 ];

        // more than one primary is running, the cluster state can not be trusted, stop all instances and configure the cluster from scratch
        if ( primaries.length > 1 ) {
            console.log( `[postgresql] More than one primary is running: ${ primaries.map( instance => instance.hostname ).join( ", " ) }, stopping all instances` );

            await Promise.all( instances.filter( instance => instance.status === "started" ).map( instance => this.#stopInstance( instance ) ) );

            if ( signal.aborted ) return true;

            // refresh statuses after stop
            await Promise.all( instances.map( instance => this.#refreshStatus( instance ) ) );

            if ( signal.aborted ) return true;

            unsettled = this.#isUnsettled( instances );

            primary = null;
        }

        // there is no primary
        if ( !primary ) {

            // do not select the primary until the state of all instances is known, otherwise the stale instance can be selected
            if ( unsettled ) {
                console.log( "[postgresql] There is no primary, but the state of some instances is unknown or they are busy, primary selection is postponed" );

                return false;
            }

            console.log( "[postgresql] There is no primary, selecting the new one" );

            primary = await this.#selectPrimary( instances, signal );

            if ( !primary || signal.aborted ) return false;
        }
        else {
            console.log( `[postgresql] Current primary: ${ primary.hostname }` );
        }

        const ok = await this.#updateStandbys( instances, primary, signal );

        console.log( `[postgresql] Standbys update finished: ${ ok
            ? "ok"
            : "there were errors" }${ unsettled
            ? ", some instances are unsettled"
            : "" }` );

        return ok && !unsettled;
    }

    // stops all instances, recovers them, selects the most advanced one and starts it as a primary
    async #selectPrimary ( instances, signal ) {

        // running standby has no timeline and lsn, they are known only after the recovery
        await Promise.all( instances.filter( instance => instance.status === "started" ).map( instance => this.#stopInstance( instance ) ) );

        if ( signal.aborted ) return;

        await Promise.all( instances.filter( instance => instance.status === "stopped" && instance.timeline === null ).map( instance => this.#recoverInstance( instance ) ) );

        if ( signal.aborted ) return;

        const candidates = instances.filter( instance => instance.status === "stopped" && instance.timeline !== null );

        // all instances must be recovered
        if ( candidates.length !== instances.length ) {
            console.log( `[postgresql] Unable to select primary, not all instances are recovered (${ candidates.length } of ${ instances.length })` );

            return;
        }

        const best = this.#findBestCandidate( candidates );

        console.log( `[postgresql] Primary candidate selected: ${ best.hostname } (timeline: ${ best.timeline }, lsn: ${ best.lsn || "-" }, promote: ${ best.standby })` );

        console.log( `[postgresql] Starting primary on ${ best.hostname } (timeline: ${ best.timeline }, lsn: ${ best.lsn || "-" }, promote: ${ best.standby })` );

        const res = await this.#startInstance( best, PRIMARY_NAME );

        if ( !res.ok ) return;

        return best;
    }

    async #updateStandbys ( instances, primary, signal ) {
        const numberOfSynchronousStandbys = this.#postgresql.config.replication.numberOfSynchronousStandbys ?? 0;

        const standbys = instances.filter( instance => instance !== primary && !instance.busy ),
            running = standbys.filter( instance => instance.status === "started" ),
            stopped = standbys.filter( instance => instance.status === "stopped" );

        // number of synchronous standbys, that are not running yet
        let missing = Math.max( 0, numberOfSynchronousStandbys - running.filter( instance => instance.role === SYNCHRONOUS_NAME ).length );

        console.log( `[postgresql] Updating standbys: running ${ running.length }, stopped ${ stopped.length }, missing synchronous ${ missing }` );

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
            res = await this.#stopInstance( instance );
            if ( !res.ok ) return res;
        }

        // recover and replay local wal, timeline and lsn are known after this
        if ( instance.timeline === null ) {
            res = await this.#recoverInstance( instance );
            if ( !res.ok ) return res;
        }

        if ( signal.aborted ) {
            console.log( `[postgresql] Starting ${ role } on ${ instance.hostname } aborted` );

            return result( [ 500, "Aborted" ] );
        }

        console.log( `[postgresql] Starting ${ role } on ${ instance.hostname }, primary: ${ primary.hostname }` );

        res = await this.#startInstance( instance, role, {
            "replicationHostname": primary.hostname,
        } );

        return res;
    }

    // logged instance operations
    async #refreshStatus ( instance ) {
        const res = await instance.getStatus();

        console.log( `[postgresql] Status of ${ instance.hostname }: ${ instance.status || "unknown" }, role: ${ instance.role || "-" }, busy: ${ instance.busy
            ? "yes"
            : "no" }` );

        return res;
    }

    async #stopInstance ( instance ) {
        const res = await instance.stop();

        if ( res.ok ) {
            console.log( `[postgresql] Instance ${ instance.hostname } stopped` );
        }
        else {
            console.log( `[postgresql] Unable to stop ${ instance.hostname }: ${ res.statusText }` );
        }

        return res;
    }

    async #recoverInstance ( instance ) {
        const res = await instance.recover();

        if ( res.ok ) {
            console.log( `[postgresql] Instance ${ instance.hostname } recovered (timeline: ${ instance.timeline }, lsn: ${ instance.lsn || "-" })` );
        }
        else {
            console.log( `[postgresql] Unable to recover ${ instance.hostname }: ${ res.statusText }` );
        }

        return res;
    }

    async #startInstance ( instance, role, options ) {
        const res = await instance.start( role, options );

        if ( res.ok ) {
            console.log( `[postgresql] Instance ${ instance.hostname } started as ${ role }` );
        }
        else {
            console.log( `[postgresql] Unable to start ${ role } on ${ instance.hostname }: ${ res.statusText }` );
        }

        return res;
    }

    // selects the instance, whose wal contains the wal of all other instances
    // numbers of timelines are not comparable by themselves: two instances can be promoted independently and get the same number, so the ancestry is checked by the timeline histories
    // if there is no such instance, the histories are diverged and some data will be lost, in this case the highest timeline wins, then the highest lsn
    // if several instances have the same wal, an instance without standby.signal is preferred, its start does not create a new timeline
    #findBestCandidate ( candidates ) {
        const dominators = candidates.filter( instance => candidates.every( other => this.#isContainedIn( other, instance ) ) );

        if ( dominators.length ) {
            return dominators.find( instance => !instance.standby ) ?? dominators[ 0 ];
        }

        console.log( `[postgresql] Histories of the instances are diverged, some data will be lost: ${ candidates.map( instance => `${ instance.hostname } (timeline: ${ instance.timeline }, lsn: ${ instance.lsn || "-" })` ).join( ", " ) }` );

        // instances, whose wal is not a part of the wal of some other instance
        const maximal = candidates.filter( instance => candidates.every( other => !( other !== instance && this.#isContainedIn( instance, other ) && !this.#isContainedIn( other, instance ) ) ) );

        let best;

        for ( const instance of maximal ) {
            if ( !best || this.#compareInstances( instance, best ) > 0 ) best = instance;
        }

        return best;
    }

    // returns true, if all wal of the instance "a" is a part of the wal of the instance "b"
    #isContainedIn ( a, b ) {

        // empty cluster has no data
        if ( a.timeline === 0 ) return true;

        const historyA = a.history ?? [],
            historyB = b.history ?? [];

        // the history of "a" must be the beginning of the history of "b"
        if ( historyA.length > historyB.length ) return false;

        for ( let n = 0; n < historyA.length; n++ ) {
            if ( historyA[ n ].timeline !== historyB[ n ].timeline ) return false;

            if ( this.#parseLsn( historyA[ n ].lsn ) !== this.#parseLsn( historyB[ n ].lsn ) ) return false;
        }

        const lsnA = this.#parseLsn( a.lsn );

        // the same timeline
        if ( a.timeline === b.timeline ) {
            return historyA.length === historyB.length && lsnA <= this.#parseLsn( b.lsn );
        }

        // "a" is on an ancestor timeline of "b", it is a part of "b" if it ends not after the point, where "b" left this timeline
        const point = historyB[ historyA.length ];

        return point?.timeline === a.timeline && lsnA <= this.#parseLsn( point.lsn );
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
