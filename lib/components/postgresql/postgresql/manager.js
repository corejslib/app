import Api from "#core/api";
import ServiceDiscovery from "#core/api/service-discovery";
import LifecycleManager from "#core/threads/lifecycle-manager";

export default class PostgresqlManager {
    #postgresql;
    #app;
    #lifecycleManager;
    #mutex;
    #api;
    #isManager = false;
    #abortController;

    constructor ( postgresql ) {
        this.#postgresql = postgresql;
        this.#app = postgresql.app;

        this.#mutex = this.#app.cluster.mutexes.get( "postgresql-manager" );

        this.#api = new Api( `ws://${ ServiceDiscovery.hostname }/${ this.#app.env.name }/postgresql-manager`, {
            "serviceDiscovery": this.#app.cluster.serviceDiscovery,
        } );

        this.#api.on( "connect", this.#onManagerConnect.bind( this ) );

        this.#api.on( "disconnect", this.#onManagerDisconnect.bind( this ) );

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

    get isConnected () {
        return this.#api.isConnected;
    }

    // public
    async start () {
        return this.#lifecycleManager.start();
    }

    async stop () {
        return this.#lifecycleManager.stop();
    }

    async waitConnect ( { signal } = {} ) {
        return this.#api.waitConnect( { signal } );
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

            this.#onLock();

            await this.#mutex.wait( { signal } );

            this.#onUnlock();
        }

        this.#abortController = null;

        this.#onUnlock();
    }

    // XXX
    async #onLock () {
        console.log( "[postgresql] This instance is selected as PostgreSQL manager" );

        this.#isManager = true;

        // XXX take port from rpc server
        this.#app.cluster.serviceDiscovery.addService( "postgresql-manager", this.app.components.get( "privateHttpServer" ).port || 81, {
            "pathname": this.app.rpc.config.frontend.location,
        } );
    }

    // XXX
    #onUnlock () {
        this.#isManager = false;

        this.#app.cluster.serviceDiscovery.deleteService( "postgresql-manager" );
    }

    // XXX
    async #onManagerConnect () {
        console.log( "[postgresql] Connected to PostgreSQL manager" );
    }

    // XXX
    async #onManagerDisconnect () {
        console.warn( "[postgresql] Disconnected from PostgreSQL manager" );
    }
}
