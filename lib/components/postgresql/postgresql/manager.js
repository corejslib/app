import LifecycleManager from "#core/threads/lifecycle-manager";

export default class PostgresqlManager {
    #postgresql;
    #app;
    #lifecycleManager;
    #mutex;
    #isManager = false;
    #abortController;
    #instances = new Map();

    constructor ( postgresql ) {
        this.#postgresql = postgresql;
        this.#app = postgresql.app;

        this.#mutex = this.#app.cluster.mutexes.get( "postgresql-manager" );

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

    // XXX
    async setInstanceStatus ( connection, { instanceId, remoteAddress, status, role, timeline, lsn } ) {
        let instance = this.#instances.get( instanceId );

        if ( !instance ) {
            connection.once( "disconnect", () => this.#onInstanceDisconnect( instanceId ) );

            instance = {
                connection,
                instanceId,
                remoteAddress,
                status,
                role,
                timeline,
                lsn,
            };

            this.#instances.set( instanceId, instance );
        }

        this.#onUpdate();
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
        this.#app.cluster.serviceDiscovery.addService( "postgresql-manager", this.app.components.get( "privateHttpServer" ).port, {
            "pathname": this.app.rpc.config.frontend.location,
        } );
    }

    // XXX
    #onUnlock () {
        this.#isManager = false;

        this.#app.cluster.serviceDiscovery.deleteService( "postgresql-manager" );
    }

    #onInstanceDisconnect ( instanceId ) {
        this.#instances.delete( instanceId );

        this.#onUpdate();
    }

    // XXX called on cluster instances uodated
    async #onUpdate () {}
}
