import Api from "#core/api";
import { sleep } from "#core/utils";

const RETRY_DELAY = 1000;

export default class NginxApi {
    #app;
    #config;
    #appName;
    #api;
    #proxies = new Map();
    #version;
    #remoteVersion;
    #updating;
    #destroyed;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#appName = this.#app.env.name;
    }

    // properties
    get app () {
        return this.#app;
    }

    get appName () {
        return this.#appName;
    }

    // public
    async init () {
        this.#api = new Api( this.#config.url, {
            "serviceDiscovery": this.#app.cluster?.serviceDiscovery,
        } );

        this.#api.on( "connect", this.#onConnect.bind( this ) );

        return result( 200 );
    }

    async destroy () {
        if ( this.#destroyed ) return;
        this.#destroyed = true;

        // stops the running update loop, remote side drops proxies on disconnect by itself
        this.#proxies.clear();

        return result( 200 );
    }

    async getCertificates ( serverNames ) {
        return this.#api.call( "nginx/get-certificates", serverNames );
    }

    async addProxy ( serverName, proxyOptions ) {
        if ( this.#destroyed ) return result( [ 400, "Nginx api destroyed" ] );

        if ( !this.#proxies.has( serverName ) ) {
            this.#proxies.set( serverName, { ...proxyOptions } );

            this.#createVersion();

            this.#update();
        }

        return result( 200 );
    }

    async deleteProxy ( serverName ) {
        if ( this.#proxies.delete( serverName ) ) {
            this.#createVersion();

            this.#update();
        }

        return result( 200 );
    }

    async setServerNames ( serverName, serverNames ) {
        const proxy = this.#proxies.get( serverName );

        if ( !proxy ) return result( [ 404, "Nginx proxy not found" ] );

        proxy.serverNames = [ ...new Set( serverNames || [] ) ];

        this.#createVersion();

        this.#update();

        return result( 200 );
    }

    // private
    #onConnect () {
        if ( this.#destroyed ) return;

        // remote state is unknown after (re)connect, force full sync
        this.#remoteVersion = null;

        if ( this.#version == null ) return;

        this.#update();
    }

    #createVersion () {
        this.#version = Math.max( Date.now(), ( this.#version ?? 0 ) + 1 );
    }

    // sends proxies to the remote host until the remote version matches the local one
    async #update () {

        // already running, it will pick up the latest version on the next iteration
        if ( this.#updating ) return;

        this.#updating = true;

        while ( !this.#destroyed && this.#api?.isConnected && this.#version !== this.#remoteVersion ) {
            const version = this.#version,
                res = await this.#api.call( "nginx/update-proxies", this.#appName, version, Object.fromEntries( this.#proxies ) );

            if ( res.ok ) {
                this.#remoteVersion = version;
            }

            // retry after a delay, do not hammer the remote host
            else {
                await sleep( RETRY_DELAY );
            }
        }

        this.#updating = false;
    }
}
