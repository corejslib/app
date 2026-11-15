import Api from "#core/api";
import ServiceDiscovery from "#core/api/service-discovery";
import LifecycleManager from "#core/threads/lifecycle-manager";

export default class PostgresqlCluster {
    #app;
    #version;
    #name;
    #lifecycleManager;
    #api;
    #remoteAddress;

    constructor ( postgresql, version, name ) {
        this.#app = postgresql.app;
        this.#version = version;
        this.#name = name;

        this.#api = new Api( `ws://${ ServiceDiscovery.hostname }/${ this.#app.env.name }/postgresql-manager`, {
            "serviceDiscovery": this.#app.cluster.serviceDiscovery,
        } );

        this.#api.on( "connect", this.#onManagerConnect.bind( this ) );

        this.#api.on( "disconnect", this.#onManagerDisconnect.bind( this ) );

        this.#api.on( "postgresql/cluster-update", this.#onClusterUpdate.bind( this ) );

        this.#lifecycleManager = new LifecycleManager( {
            "onStart": this.#start.bind( this ),
            "onStop": this.#stop.bind( this ),
        } );
    }

    // properties
    get version () {
        return this.#version;
    }

    get name () {
        return this.#name;
    }

    // public
    async start () {
        return this.#lifecycleManager.start();
    }

    async stop () {
        return this.#lifecycleManager.stop();
    }

    // private
    // XXX
    async #start ( signal ) {
        let res;

        // get this instance remote address
        if ( !this.#remoteAddress ) {
            res = await this.app.cluster.getIpAddress();
            if ( !res.ok ) return res;

            this.#remoteAddress = res.data;
        }

        const connected = await this.#api.waitConnect( { signal } );
        if ( !connected ) return result( [ 500, "Aborted" ] );

        // register on cluster manager
        res = await this.#api.call( "postgresql/set-instance-status", {
            "instanceId": this.#app.env.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "stopped",
            "role": null,
        } );
        if ( !res.ok ) return res;

        // XXX perform recovery, apply lsn
        // XXX ger timeline, lsn

        // send timeline, lsn
        res = await this.#api.call( "postgresql/set-instance-status", {
            "instanceId": this.#app.env.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "stopped",
            "role": null,
            "timeline": null,
            "lsn": null,
        } );
        if ( !res.ok ) return res;

        // XXX wait for role from manager

        // XXX start using assigned role

        res = await this.#api.call( "postgresql/set-instance-status", {
            "instanceId": this.#app.env.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "started",
            "role": null,
            "timeline": null,
            "lsn": null,
        } );
        if ( !res.ok ) return res;

        // XXX wait for cluster start event

        // XXX register on service-discovery, nginx

        return result( 200 );
    }

    async #stop () {}

    #onManagerConnect () {}

    #onManagerDisconnect () {}

    #onClusterUpdate () {}
}
