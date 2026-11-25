import childProcess from "node:child_process";
import fs from "node:fs";
import * as certificates from "#core/certificates";
import DigitalSize from "#core/digital-size";
import ejs from "#core/ejs";
import { rmDirEntries } from "#core/fs";
import geoipCountry from "#core/geoip-country";
import Interval from "#core/interval";
import IpRange from "#core/ip/range";
import subnets from "#core/ip/subnets";
import Counter from "#core/threads/counter";
import Mutex from "#core/threads/mutex";
import { sleep } from "#core/utils";
import { validateIpPort } from "#core/validate";
import NginxConfig from "./nginx/config.js";
import NginxProxies from "./nginx/proxies.js";
import NginxProxyServerName from "./nginx/proxy/server-name.js";

try {
    var { "default": geoipCity } = await import( "@corejslib/geopip-city" );
}
catch {}

try {
    var { "default": geoipAsn } = await import( "@corejslib/geopip-asn" );
}
catch {}

const nginxConfigTemplate = await ejs.fromFile( new URL( "resources/nginx.conf", import.meta.url ) );

export default class Nginx {
    #app;
    #config;

    #dataDir;
    #cacheDir;
    #configsDir;
    #configPath;
    #setRealIpFromPath;

    #mutexSet = new Mutex.Set();
    #proxies;
    #activityCounter = new Counter();

    #nginx;
    #isStarted = false;
    #isDestroying = false;
    #pendingReload = false;

    #defaultServerName;

    #compressMimeTypes;
    #trustedSubnets;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#dataDir = this.#app.env.dataDir + "/nginx";

        this.#cacheDir = this.#dataDir + "/cache";

        this.#configsDir = this.app.env.tmpDir + "/nginx";

        this.#configPath = this.#configsDir + "/nginx.conf";

        this.#setRealIpFromPath = this.#configsDir + "/set-real-ip-from.nginx.conf";

        this.#proxies = new NginxProxies( this );

        process.on( "exit", () => this.#nginx?.kill( "SIGTERM" ) );

        subnets.on( "add", this.#onSubnetsUpdate.bind( this ) );
        subnets.on( "delete", this.#onSubnetsUpdate.bind( this ) );
        subnets.on( "update", this.#onSubnetsUpdate.bind( this ) );

        geoipCountry.on( "update", () => this.reload() );
        geoipCity?.on( "update", () => this.reload() );
        geoipAsn?.on( "update", () => this.reload() );
    }

    // properties
    get app () {
        return this.#app;
    }

    get config () {
        return this.#config;
    }

    get isStarted () {
        return this.#isStarted;
    }

    get isDestroying () {
        return this.#isDestroying;
    }

    get dataDir () {
        return this.#dataDir;
    }

    get cacheDir () {
        return this.#cacheDir;
    }

    get configsDir () {
        return this.#configsDir;
    }

    get setRealIpFromPath () {
        return this.#setRealIpFromPath;
    }

    get privateHttpServerUpstream () {
        const component = this.app.components.get( "privateHttpServer" );

        if ( !component ) return null;

        return "private-http-server";
    }

    get proxies () {
        return this.#proxies;
    }

    get listenIpV4 () {
        return !this.config.listenIpFamily || this.config.listenIpFamily === 4;
    }

    get listenIpV6 () {
        return !this.config.listenIpFamily || this.config.listenIpFamily === 6;
    }

    get quicEnabled () {
        return this.config.quicEnabled;
    }

    get defaultServerName () {
        return ( this.#defaultServerName ??= new NginxProxyServerName( this ) );
    }

    get dhParamsPath () {
        return certificates.dhParamsPath;
    }

    get compressMimeTypes () {
        this.#compressMimeTypes ??= this.config.compressMimeTypes.join( " " );

        return this.#compressMimeTypes;
    }

    get trustedSubnets () {
        if ( !this.#trustedSubnets ) {
            const config = this.#config.setRealIpFrom;

            this.#trustedSubnets = {};

            if ( config?.length ) {
                for ( const subnet of config ) {

                    // custom ip-address
                    if ( IpRange.isValid( subnet ) ) {
                        this.#trustedSubnets.custom ||= [];

                        this.#trustedSubnets.custom.push( subnet );
                    }

                    // subnet name
                    else {
                        const range = subnets.get( subnet )?.toJSON();

                        if ( !range?.length ) continue;

                        this.#trustedSubnets[ subnet ] = range;
                    }
                }
            }
        }

        return this.#trustedSubnets;
    }

    // XXX enable on nginx 1.32
    get geoip () {
        return {
            "enabled": false,
            "country": geoipCountry.dbPath,
            "city": geoipCity?.dbPath,
            "asn": geoipAsn?.dbPath,
        };
    }

    // public
    async start () {
        if ( this.#isStarted ) return result( 200 );

        const mutex = this.#mutexSet.get( "start" );

        await mutex.lock();

        try {

            // started while waiting for the lock
            if ( this.#isStarted ) return result( 200 );

            await this.#updateConfig();

            const res = await this.test();

            if ( !res.ok ) return res;

            if ( this.isDestroying ) return result( [ 400, "Nginx is destroying" ] );

            this.#activityCounter.value++;

            // start nginx
            this.#nginx = childProcess.spawn(
                "nginx",
                [

                    //
                    "-e",
                    "/dev/stderr",
                    "-c",
                    this.#configPath,
                ],
                {
                    "detached": true,
                    "stdio": [ "ignore", "inherit", "inherit" ],
                }
            );

            this.#nginx.on( "exit", this.#onNginxExit.bind( this ) );

            this.#isStarted = true;

            return result( 200 );
        }
        finally {
            mutex.unlock();
        }
    }

    async destroy () {
        this.#isDestroying = true;

        // stop nginx
        return this._stop();
    }

    async reload () {
        return this.#updateConfig();
    }

    async test () {
        if ( this.isDestroying ) return result( [ 400, "Nginx is destroying" ] );

        const mutex = this.#mutexSet.get( "test" );

        await mutex.lock();

        const res = await new Promise( resolve => {
            childProcess.execFile(
                "nginx",
                [

                    //
                    "-t",
                    "-q",
                    "-c",
                    this.#configPath,
                ],
                {
                    "encoding": "utf8",
                    "maxBuffer": Infinity,
                },
                ( error, stdout, stderr ) => {
                    if ( error ) {
                        resolve( result( [ 400, stderr ] ) );
                    }
                    else {
                        resolve( result( 200 ) );
                    }
                }
            );
        } );

        mutex.unlock();

        return res;
    }

    validateIpPort ( port ) {
        if ( validateIpPort( port ) ) {
            return port;
        }
    }

    async clearCache () {
        await rmDirEntries( this.cacheDir, {
            "force": true,
            "recursive": true,
        } );

        console.info( "[nginx] Cache cleared" );
    }

    // protected
    async _stop () {
        this.#nginx?.kill( "SIGTERM" );

        return this.#activityCounter.wait();
    }

    async _stopGraceful () {
        this.#nginx?.kill( "SIGQUIT" );

        return this.#activityCounter.wait();
    }

    _stopWorkersGraceful () {
        this.#nginx?.kill( "SIGWINCH" );
    }

    _upgradeExecutable () {
        this.#nginx?.kill( "SIGUSR2" );
    }

    _reopenLogFiles () {
        this.#nginx?.kill( "SIGUSR1" );
    }

    // private
    #onNginxExit ( code, signal ) {
        this.#isStarted = false;

        this.#nginx = null;

        console.log( `[nginx] process exited, code: ${ code }` );

        this.#activityCounter.value--;

        process.destroy( { code } );
    }

    async #updateConfig () {
        const mutex = this.#mutexSet.get( "reload" );

        if ( !mutex.tryLock() ) {
            this.#pendingReload = true;

            return mutex.wait();
        }

        try {

            // wait for nginx reloaded
            await sleep( 1000 );

            while ( true ) {
                this.#pendingReload = false;

                // remove all configs
                fs.rmSync( this.configsDir, { "recursive": true, "force": true } );

                // create http cache directory
                fs.mkdirSync( this.#cacheDir, { "recursive": true } );

                const config = new NginxConfig( this );

                await config.generate();

                if ( !this.#pendingReload ) break;
            }

            // write nginx config
            this.#writeNginxConfig();

            console.info( "[nginx] Reloaded" );
            this.#nginx?.kill( "SIGHUP" );
        }
        finally {
            mutex.unlock();
        }
    }

    #writeNginxConfig () {

        // generate nginx config
        const config = nginxConfigTemplate.renderSync( {
            "nginx": this,
            "maxBodySize": DigitalSize.new( this.config.maxBodySize ).toNginx(),
            "cacheMaxSize": DigitalSize.new( this.config.cacheMaxSize ).toNginx(),
            "cacheMinFree": DigitalSize.new( this.config.cacheMinFree ).toNginx(),
            "cacheInactive": Interval.new( this.config.cacheInactive ).toNginx(),
            "cacheBypass": this.config.cacheBypass,
        } );

        // deploy nginx config
        fs.mkdirSync( this.configsDir, { "recursive": true } );
        fs.writeFileSync( this.#configPath, config );

        this.#writeSetRealIpFromConfig();
    }

    #writeSetRealIpFromConfig () {
        const ranges = this.trustedSubnets,
            setRealIpFrom = [ "# unix socket\nset_real_ip_from    unix:;\n" ];

        for ( const [ rangeName, range ] of Object.entries( ranges ).sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) ) ) {
            setRealIpFrom.push( `# ${ rangeName }\n` + range.map( cidr => `set_real_ip_from    ${ cidr };\n` ).join( "" ) );
        }

        fs.writeFileSync( this.#setRealIpFromPath, setRealIpFrom.join( "\n" ) );
    }

    #onSubnetsUpdate ( name ) {

        // subnet is not used in the config
        if ( !this.#config.setRealIpFrom?.includes( name ) ) return;

        this.#trustedSubnets = null;

        this.reload();
    }
}
