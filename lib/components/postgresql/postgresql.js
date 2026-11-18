import fs from "node:fs";
import path from "node:path";
import env from "#core/env";
import PostgreSqlCluster from "./postgresql/cluster.js";
import PostgresqlManager from "./postgresql/manager.js";
import utils from "./postgresql/utils.js";

// NOTE: https://www.postgresql.org/docs/current/server-shutdown.html

export default class PostgreSql {
    #app;
    #config;
    #dataDir;
    #unixSocketDir;
    #publicUnixSocketDir;
    #manager;
    #cluster;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#dataDir = this.config.dataDir || this.app.env.dataDir + "/postgresql";
        if ( !path.isAbsolute( this.#dataDir ) ) this.#dataDir = path.join( env.root, this.#dataDir );

        this.#unixSocketDir = "/var/run/postgresql";
        this.#publicUnixSocketDir = "/var/run/postgresql-public";

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

    get publicUnixSocketDir () {
        return this.#publicUnixSocketDir;
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

        await fs.promises.mkdir( this.publicUnixSocketDir, { "recursive": true } );
        await utils.chmodDir( this.publicUnixSocketDir );

        this.#cluster = new PostgreSqlCluster( this, process.env.POSTGRESQL_VERSION, this.config.clusterName );

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

    async destroy () {
        await this.#manager.stop();

        await this.#cluster.stop();

        return result( 200 );
    }
}
