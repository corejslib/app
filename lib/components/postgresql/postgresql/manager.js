import Api from "#core/api";
import Events from "#core/events";
import LifecycleManager from "#core/threads/lifecycle-manager";

export default class PostgresqlManager {
    #postgresql;
    #app;
    #lifecycleManager;
    #mutex;
    #isManager = false;
    #abortController;
    #instances = new Map();
    #serviceDiscoveryEvents;

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

        this.#app.cluster.serviceDiscovery.addService( "postgresql-manager-rpc", this.app.components.get( "privateHttpServer" ).port, {
            "pathname": this.app.rpc.config.frontend.location,
        } );

        this.#serviceDiscoveryEvents.on( `add/${ this.#app.env.name }/postgresql-instance-rpc`, this.#addInstance.bind( this ) );
        this.#serviceDiscoveryEvents.on( `delete/${ this.#app.env.name }/postgresql-instance-rpc`, this.#deleteInstance.bind( this ) );

        const services = await this.#app.cluster.serviceDiscovery.getServices( this.#app.env.name, "postgresql-instance-rpc" );

        for ( const service of services ) {
            this.#addInstance( service );
        }
    }

    // XXX
    #stopManager () {
        this.#isManager = false;

        this.#serviceDiscoveryEvents.offAll();

        this.#app.cluster.serviceDiscovery.deleteService( "postgresql-manager-rpc" );
    }

    async #addInstance ( { uri, hostname } ) {
        if ( this.#instances.get( uri ) ) return;

        const api = new Api( `ws://${ uri }` ),
            instance = {
                uri,
                api,
            };

        this.#instances.set( uri, instance );

        this.#onUpdate();
    }

    #deleteInstance ( { uri } ) {
        const instance = this.#instances.get( uri );

        if ( !instance ) return;

        this.#instances.delete( uri );

        instance.api.forceDestroy();

        this.#onUpdate();
    }

    // XXX called on cluster instances uodated
    async #onUpdate () {
console.log( "---", this.#instances )
    }
}
