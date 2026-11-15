import fs from "node:fs";
import path from "node:path";
import env from "#core/env";
import PostgreSqlCluster from "./postgresql/cluster1.js";
import PostgresqlManager from "./postgresql/manager.js";
import utils from "./postgresql/utils.js";

// NOTE: https://www.postgresql.org/docs/current/server-shutdown.html

export default class PostgreSql {
    #app;
    #config;
    #dataDir;
    #unixSocketDir;
    #manager;
    #cluster;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#dataDir = this.config.dataDir || this.app.env.dataDir + "/postgresql";
        if ( !path.isAbsolute( this.#dataDir ) ) this.#dataDir = path.join( env.root, this.#dataDir );

        this.#unixSocketDir = "/var/run/postgresql";

        this.#manager = new PostgresqlManager( this );
    }

    // properties
    get app () {
        return this.#app;
    }

    get config () {
        return this.#config;
    }

    get dataDir () {
        return this.#dataDir;
    }

    get unixSocketDir () {
        return this.#unixSocketDir;
    }

    get manager () {
        return this.#manager;
    }

    get cluster () {
        return this.#cluster;
    }

    // public
    async init () {

        // init data dir
        await fs.promises.mkdir( this.dataDir, { "recursive": true } );

        // init unix socket dir
        await fs.promises.mkdir( this.unixSocketDir, { "recursive": true } );
        await utils.chmodDir( this.unixSocketDir );

        this.#cluster = new PostgreSqlCluster( this, process.env.POSTGRESQL_VERSION, this.config.clusterName );

        // XXX
        // this.#cluster.on( "stop", this.#onClusterStop.bind( this ) );

        return result( 200 );
    }

    async start () {
        let res;

        // start manager
        res = await this.#manager.start();
        if ( !res.ok ) return res;

        // start cluster
        res = await this.#cluster.start();
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async afterAppStarted () {
        this.#registerNginx;

        return result( 200 );
    }

    async destroy () {
        await this.#manager.stop();

        return this.#cluster.stop();
    }

    // private
    // #onClusterStop ( code, signal ) {
    //     process.destroy( { code } );
    // }

    #registerNginx () {

        // nginx upstream
        if ( this.config.nginx.enabled && this.app.nginxUpstream ) {
            const servers = [
                {
                    "port": this.config.nginx.port,
                    "type": "tcp",
                    "useSsl": true,
                },
            ];

            if ( this.config.nginx.defaultServer ) {
                servers.push( {
                    "port": this.config.nginx.port,
                    "type": "tcp",
                    "useSsl": false,
                } );
            }

            this.app.nginxUpstream.addProxy( "postgresql-" + this.mode, {
                "upstreamPort": 5432,
                "serverNames": this.config.nginx.serverNames,
                servers,
            } );
        }

        this.app.cluster?.serviceDiscovery.addService( "postgresql-" + this.mode, 5432 );
    }
}
