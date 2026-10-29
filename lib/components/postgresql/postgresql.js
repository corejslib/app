import fs from "node:fs";
import path from "node:path";
import env from "#core/env";
import PostgreSqlCluster from "./postgresql/cluster.js";
import utils from "./postgresql/utils.js";

// NOTE: https://www.postgresql.org/docs/current/server-shutdown.html

export default class PostgreSql {
    #app;
    #config;
    #dataDir;
    #unixSocketDir;
    #cluster;
    #replicationHostname;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#dataDir = this.config.dataDir || this.app.env.dataDir + "/postgresql";
        if ( !path.isAbsolute( this.#dataDir ) ) this.#dataDir = path.join( env.root, this.#dataDir );

        this.#unixSocketDir = "/var/run/postgresql";
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

    get mode () {
        return this.config.mode;
    }

    get isPrimary () {
        return this.config.mode === "primary";
    }

    get isStandby () {
        return this.isSynchronousStandby || this.isAsynchronousStandby;
    }

    get isSynchronousStandby () {
        return this.config.mode === "standby-synchronous";
    }

    get isAsynchronousStandby () {
        return this.config.mode === "standby-asynchronous";
    }

    get isBackup () {
        return this.config.mode === "backup";
    }

    get replicationHostname () {
        if ( this.#replicationHostname === undefined ) {
            if ( this.isPrimary ) {
                this.#replicationHostname = null;
            }
            else if ( this.isSynchronousStandby ) {
                this.#replicationHostname = this.config.replication.primary.hostname;
            }
            else if ( this.isAsynchronousStandby ) {
                if ( this.config.replication.asynchronous.replicateFrom === "primary" ) {
                    this.#replicationHostname = this.config.replication.primary.hostname;
                }
                else {
                    this.#replicationHostname = this.config.replication.synchronous.hostname;
                }
            }
            else if ( this.isBackup ) {
                this.#replicationHostname = this.config.replication.primary.hostname;
            }
        }

        return this.#replicationHostname;
    }

    get cluster () {
        return this.#cluster;
    }

    // public
    // XXX
    async init () {

        // check config
        if ( this.isSynchronousStandby ) {
            if ( !this.config.replication?.synchronous?.numberOfStandbys ) {
                return result( [ 400, "Synchronous standbys are not enabled" ] );
            }
        }
        else if ( this.isAsynchronousStandby && this.config.replication?.asynchronous?.replicateFrom === "sync" && !this.config.replication?.synchronous?.numberOfStandbys ) {
            return result( [ 400, "Can't replicate from sync standby" ] );
        }

        // init data dir
        await fs.promises.mkdir( this.dataDir, { "recursive": true } );

        // init unix socket dir
        await fs.promises.mkdir( this.unixSocketDir, { "recursive": true } );
        await utils.chmodDir( this.unixSocketDir );

        this.#cluster = new PostgreSqlCluster( this, process.env.POSTGRESQL_VERSION, this.config.clusterName );

        // start cluster
        return this.#cluster.start();

        // XXX
        // this.#cluster.on( "stop", this.#onClusterStop.bind( this ) );
    }

    async start () {

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

            await this.app.nginxUpstream.addProxy( "postgresql-server", {
                "upstreamPort": 5432,
                "serverNames": this.config.nginx.serverNames,
                servers,
            } );
        }

        this.app.cluster?.serviceDiscovery.addService( "postgresql-" + this.mode, 5432, "/" );

        return result( 200 );
    }

    async destroy () {
        return this.#cluster.stop();
    }

    // private
    // XXX
    // #onClusterStop ( code, signal ) {
    //     console.log( `PostgreSQL process exited, code: ${ code }` );

    //     process.destroy( { code } );
    // }
}
