import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Api from "#core/api";
import ServiceDiscovery from "#core/api/service-discovery";
import RandomValues from "#core/crypto/random-values";
import { pathExists } from "#core/fs";
import sql from "#core/sql";
import LifecycleManager from "#core/threads/lifecycle-manager";
import { TmpFile } from "#core/tmp";
import utils from "./utils.js";

export default class PostgresqlCluster {
    #postgresql;
    #app;
    #version;
    #name;
    #binDir;
    #dataDir;
    #configPath;
    #autoConfigPath;
    #recoverySignalPath;
    #standbySignalPath;
    #defaultConfigPath;
    #userConfigPath;
    #replicationConfigPath;
    #recoveryConfigPath;
    #lifecycleManager;
    #api;
    #remoteAddress;

    constructor ( postgresql, version, name ) {
        this.#postgresql = postgresql;
        this.#app = postgresql.app;
        this.#version = version;
        this.#name = name;

        this.#binDir = path.join( "/usr/lib/postgresql", String( this.#version ), "bin" );
        this.#dataDir = path.join( this.#postgresql.dataDir, "clusters", String( this.#version ), this.#name );
        this.#configPath = path.join( this.#dataDir, "postgresql.conf" );
        this.#autoConfigPath = path.join( this.#dataDir, "postgresql.auto.conf" );
        this.#recoverySignalPath = path.join( this.#dataDir, "recovery.signal" );
        this.#standbySignalPath = path.join( this.#dataDir, "standby.signal" );
        this.#defaultConfigPath = path.join( this.#dataDir, "conf.d/0-postgresql.conf" );
        this.#userConfigPath = path.join( this.#dataDir, "conf.d/10-user.conf" );
        this.#replicationConfigPath = path.join( this.#dataDir, "conf.d/20-replication.conf" );
        this.#recoveryConfigPath = path.join( this.#dataDir, "conf.d/30-recovery.conf" );

        this.#api = new Api( `ws://${ ServiceDiscovery.hostname }/${ this.#app.env.name }/postgresql-manager`, {
            "serviceDiscovery": this.#app.cluster.serviceDiscovery,
        } );

        this.#api.on( "connect", this.#onManagerConnect.bind( this ) );

        this.#api.on( "disconnect", this.#onManagerDisconnect.bind( this ) );

        this.#api.on( "postgresql/cluster-update", this.#onClusterUpdate.bind( this ) );

        this.#lifecycleManager = new LifecycleManager( {
            "onStart": this.#start.bind( this ),
            "onStop": this.#stop.bind( this ),
            "onDestroyThreads": this.#stopClusterImmediate.bind( this ),
        } );

        process.once( "exit", () =>
            this.#spawnSync(
                `${ this.binDir }/pg_ctl`,
                [

                    //
                    "stop",
                    `--pgdata=${ this.#dataDir }`,
                    "--wait",
                    "--mode=immediate",
                ],
                {
                    "stdio": "ignore",
                }
            ) );
    }

    // properties
    get app () {
        return this.#postgresql.app;
    }

    get postgresql () {
        return this.#postgresql;
    }

    get version () {
        return this.#version;
    }

    get name () {
        return this.#name;
    }

    get binDir () {
        return this.#binDir;
    }

    get dataDir () {
        return this.#dataDir;
    }

    // public
    async start () {
        return this.#lifecycleManager.start();
    }

    async stop () {
        return this.#lifecycleManager.stop();
    }

    async forceStop () {
        return this.#lifecycleManager.forceStop();
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

        res = await this.#prepareCluster();
        if ( !res.ok ) return res;

        const timeline = res.data.timeline,
            lsn = res.data.lsn;

        // send timeline, lsn
        res = await this.#api.call( "postgresql/set-instance-status", {
            "instanceId": this.#app.env.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "stopped",
            "role": null,
            timeline,
            lsn,
        } );
        if ( !res.ok ) return res;

        // XXX wait for role from manager

        // XXX start using assigned role
        res = await this.#startPrimary();
        if ( !res.ok ) return res;

        res = await this.#api.call( "postgresql/set-instance-status", {
            "instanceId": this.#app.env.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "started",
            "role": null,
            timeline,
            lsn,
        } );
        if ( !res.ok ) return res;

        // XXX wait for cluster start event

        // XXX register on service-discovery, nginx

        return result( 200 );
    }

    async #stop () {
        await this.#stopClusterFast();

        return result( 200 );
    }

    #onManagerConnect () {}

    #onManagerDisconnect () {}

    #onClusterUpdate () {}

    async #isClusterExists () {
        return pathExists( path.join( this.dataDir, "PG_VERSION" ) );
    }

    async #prepareCluster () {
        let res;

        // init data dir
        res = await this.#initDataDir();
        if ( !res.ok ) return res;

        // init cluster
        if ( !( await this.#isClusterExists() ) ) {
            res = await this.#initDatabase();
            if ( !res.ok ) return res;
        }

        res = await this.#spawnPgCtl( "start", {
            "options": {
                "listen_addresses": "",
                "archive_mode": "off",
                "archive_command": "/bin/true",
            },
        } );
        if ( !res.ok ) return res;

        const dbh = sql.new( "postgresql:" );

        res = await dbh.selectRow( sql`SELECT timeline_id AS timeline, pg_current_wal_flush_lsn() AS lsn FROM pg_control_checkpoint()` );

        dbh.destroy();

        await this.#stopClusterFast();

        return res;
    }

    // XXX
    async #startCluster ( primary ) {

        // write configs
        await this.#writeHbaConfig();
        await this.#writeUserConfig();

        // XXX
        // update replication role
        // res = await this.#initPrimary( signal );
        // this.#log( "Server initialization status:", res );
        // if ( !res.ok ) return res;

        if ( primary ) {

            // XXX if was standby - promote
            // rm -f "$PGDATA/standby.signal" "$PGDATA/recovery.signal"
            // pg_ctl start -D "$PGDATA" -w -t 86400

            if ( hasStandbySignal ) {

                // XXX pg_ctl promote -D "$PGDATA" -w
            }
        }
        else {

            // touch "$PGDATA/standby.signal"

            // cat >> "$PGDATA/postgresql.auto.conf" <<EOF
            // primary_conninfo = 'host=PRIMARY_HOST port=5432 user=replicator application_name=NODE_NAME'
            // primary_slot_name = 'node_slot'
            // recovery_target_timeline = 'latest'
            // hot_standby = on
            // EOF

            // pg_ctl start -D "$PGDATA" -w -t 86400
        }

        // write configs
        await this.#writeReplicationConfig();

        // start server
        // return this.#startPostgresqlProcess( {
        //     "network": true,
        //     signal,
        // } );
    }

    // XXX
    async #startPrimary () {
        let res;

        // init data dir
        res = await this.#initDataDir();
        if ( !res.ok ) return res;

        // init cluster db
        if ( !( await this.#isClusterExists() ) ) {
            res = await this.#initDatabase();
            if ( !res.ok ) return res;
        }

        // write configs
        await this.#writeHbaConfig();
        await this.#writeUserConfig();

        // the former standby must be promoted explicitly, to switch the timeline
        const isPromotion = await pathExists( this.#standbySignalPath );

        await this.#deleteReplicationConfig();

        // promote standby
        if ( isPromotion ) {

            // keep standby.signal (without primary_conninfo) until the promotion
            await utils.writeFile( this.#standbySignalPath, "" );

            res = await this.#spawnPgCtl( "promote", {
                "options": {
                    "listen_addresses": "",
                },
            } );
            if ( !res.ok ) return res;

            await this.#stopClusterFast();
        }

        // write configs
        await this.#writeReplicationConfig();

        // start server
        res = await this.#spawnPgCtl( "start" );
        if ( !res.ok ) return res;

        // update replication role
        const dbh = sql.new( "postgresql:" );
        res = await dbh.exec( sql`

-- replication role
-- DROP ROLE IF EXISTS ${ sql.id( this.config.replication.username ) };

-- CREATE ROLE ${ sql.id( this.config.replication.username ) } WITH REPLICATION LOGIN;
DO
$$
BEGIN
    IF NOT EXISTS ( SELECT FROM pg_catalog.pg_roles WHERE rolname = ${ this.config.replication.username } ) THEN
        CREATE ROLE ${ sql.id( this.config.replication.username ) } WITH REPLICATION LOGIN;
    END IF;
END
$$;

ALTER ROLE ${ sql.id( this.config.replication.username ) } WITH PASSWORD ${ this.config.replication.password };

-- pg_rewind permissions
GRANT EXECUTE ON function pg_catalog.pg_ls_dir ( text, boolean, boolean ) TO ${ sql.id( this.config.replication.username ) };
GRANT EXECUTE ON function pg_catalog.pg_stat_file ( text, boolean ) TO ${ sql.id( this.config.replication.username ) };
GRANT EXECUTE ON function pg_catalog.pg_read_binary_file ( text ) TO ${ sql.id( this.config.replication.username ) };
GRANT EXECUTE ON function pg_catalog.pg_read_binary_file ( text, bigint, bigint, boolean ) TO ${ sql.id( this.config.replication.username ) };
` );
        dbh.forceDestroy();
        if ( !res.ok ) return res;

        return result( 200 );
    }

    // XXX
    async #startStandby ( { primaryHost } ) {}

    async #stopClusterFast () {
        return this.#stopCluster( "fast" );
    }

    async #stopClusterImmediate () {
        return this.#stopCluster( "immediate" );
    }

    // eslint-disable-next-line no-unused-private-class-members
    async #stopClusterSmart () {
        return this.#stopCluster( "smart" );
    }

    async #stopCluster ( mode = "fast" ) {
        return this.#spawnPgCtl( "stop", {
            mode,
        } );
    }

    async #initDataDir () {

        // init data dir
        await fs.promises.mkdir( this.dataDir, { "recursive": true } );
        await utils.chmodDir( this.dataDir, { "recursive": true } );

        return result( 200 );
    }

    async #initConfigDir () {

        // create "conf.d" dir
        if ( !( await pathExists( this.dataDir + "/conf.d" ) ) ) {
            await fs.promises.mkdir( this.dataDir + "/conf.d", { "recursive": true } );
            await utils.chmodDir( this.dataDir + "/conf.d" );

            // move postgresql config
            await fs.promises.rename( this.#configPath, this.#defaultConfigPath );
            await utils.chmodFile( this.#defaultConfigPath );

            // rewrite postgresql config
            await utils.writeFile( this.#configPath, "include_dir = 'conf.d'\n" );
        }
    }

    async #initDatabase () {
        if ( await this.#isClusterExists() ) return result( [ 500, "Cluster already exists" ] );

        const password = Buffer.from( RandomValues.default.getRandomArrayBuffer( 16 ) ).toBase64( { "alphabet": "base64url", "omitPadding": true } ),
            passwordFile = new TmpFile();

        await utils.writeFile( passwordFile.path, password );

        const proc = this.#spawn(
            `${ this.binDir }/initdb`,
            [

                //
                "--username=postgres",
                `--pwfile=${ passwordFile }`,
                `--pgdata=${ this.dataDir }`,
                "--encoding=UTF8",
                "--locale-provider=icu",
                "--icu-locale=und",
                "--lc-collate=C.UTF-8",
                "--lc-ctype=C.UTF-8",
            ],
            {
                "stdio": "ignore",
            }
        );

        const res = await new Promise( resolve => proc.once( "close", code => resolve( code
            ? result( 500 )
            : result( 200 ) ) ) );

        await passwordFile.destroy();

        return res;
    }

    async #writeHbaConfig ( { replication } = {} ) {
        const config = [];

        // generate pg_hba.conf
        for ( const access of this.config.access ) {
            const line = [];

            // replication mode
            if ( replication ) {
                if ( access.host !== "local" && access.user !== this.config.replication.username ) {
                    continue;
                }
            }

            for ( const name of [ "host", "database", "user", "address", "auth-method", "auth-options" ] ) {
                if ( !access[ name ] ) continue;

                line.push( access[ name ] );
            }

            config.push( line.join( " " ) );
        }

        await utils.writeFile( this.dataDir + "/pg_hba.conf", config.join( "\n" ) + "\n" );
    }

    async #writeUserConfig () {
        await this.#initConfigDir();

        // generate user config
        return utils.writeConfig( this.#userConfigPath, this.config.settings );
    }

    // XXX primary
    async #writeReplicationConfig () {
        await this.#deleteReplicationConfig();

        var config;

        // primary
        if ( this.postgresql.isPrimary ) {
            config = {
                "wal_level": "replica",
            };

            if ( this.config.backup.enabled ) {
                config.summarize_wal = true;

                // XXX incremental_timeout * 2
                // minutes, 10 days
                // config.wal_summary_keep_time = 14_400

                // // PITR
                if ( this.config.backup.pitrEnabled ) {

                    // config.archive_mode = true;
                    // config.archive_command = `gzip -9 -c %p > ${ this.backup.walsDir }/%f.gz`;
                }
            }

            let numberOfStandbys = 0;

            if ( this.config.replication?.synchronous?.numberOfStandbys ) {
                numberOfStandbys += this.config.replication.synchronous.numberOfStandbys;
            }

            if ( this.config.backup?.enabled && this.config.backup?.pitrEnabled ) {
                numberOfStandbys += 1;
            }

            if ( numberOfStandbys ) {
                config.synchronous_standby_names = `${ numberOfStandbys } ( ${ SYNCHRONOUS_NAME } )`;
            }
        }

        // syncronous stanby
        else if ( this.postgresql.isSynchronousStandby ) {
            config = {
                "primary_conninfo": `host=${ this.postgresql.replicationHostname } port=${ this.config.replication.port } user=${ this.config.replication.username } password=${ this.config.replication.password } application_name=${ SYNCHRONOUS_NAME }`,

                "primary_slot_name": this.slotId,
            };
        }

        // asyncronous standby
        else {
            config = {
                "primary_conninfo": `host=${ this.postgresql.replicationHostname } port=${ this.config.replication.port } user=${ this.config.replication.username } password=${ this.config.replication.password } application_name=${ ASYNCHRONOUS_NAME }`,

                "primary_slot_name": this.slotId,
            };
        }

        if ( await utils.writeConfig( this.#replicationConfigPath, config ) ) {

            // write standby.signal
            if ( !this.postgresql.isPrimary ) {
                await utils.writeFile( this.#standbySignalPath, "" );
            }
        }
    }

    async #deleteReplicationConfig () {
        await Promise.all( [

            //
            fs.promises.rm( this.#replicationConfigPath, { "force": true } ),
            fs.promises.rm( this.#standbySignalPath, { "force": true } ),
        ] );

        // remove replication auto config
        if ( await pathExists( this.autoConfigPath ) ) {
            const config = fs
                .readFileSync( this.autoConfigPath, "utf8" )
                .split( "\n" )
                .map( line => line.trim() )
                .filter( line => {
                    if ( line.startsWith( "primary_conninfo" ) ) return false;

                    if ( line.startsWith( "primary_slot_name" ) ) return false;

                    return true;
                } )
                .join( "\n" );

            await utils.writeFile( this.autoConfigPath, config );
        }
    }

    async #spawnPgCtl ( command, { wait = true, timeout = 86_400, mode, options, stdio = "inherit" } ) {
        const args = [ command, `--pgdata=${ this.#dataDir }` ];

        if ( wait ) args.push( "--wait" );

        if ( timeout ) args.push( `--timeout=${ timeout }` );

        if ( mode ) args.push( `--mode=${ mode }` );

        if ( options ) {
            args.push( "--options=" +
                    Object.entries( options )
                        .map( ( [ key, value ] ) => `-c ${ key }="${ value }"` )
                        .join( " " ) );
        }

        const proc = this.#spawn( `${ this.binDir }/pg_ctl`, args, {
            stdio,
        } );

        return new Promise( resolve => proc.once( "close", code => resolve( code
            ? result( 500 )
            : result( 200 ) ) ) );
    }

    #spawn ( command, args, { cwd, stdio, env, uid = true, signal } = {} ) {
        const options = {
            cwd,
            "stdio": stdio || "inherit",
            env,
            signal,
        };

        if ( uid ) {
            options.uid = utils.uid;
            options.gid = utils.gid;
        }

        return childProcess.spawn( command, args, options );
    }

    #spawnSync ( command, args, { cwd, stdio, env, uid = true, signal } = {} ) {
        const options = {
            cwd,
            "stdio": stdio || "inherit",
            env,
            signal,
        };

        if ( uid ) {
            options.uid = utils.uid;
            options.gid = utils.gid;
        }

        const res = childProcess.spawnSync( command, args, options );

        if ( res.code ) {
            return result( 500 );
        }
        else {
            return result( 200 );
        }
    }
}

// -----BEGIN LINT LOG-----
// +----------+----------+----------------------------------------------------------------------------+
// | Severity |     Line | Desctiption                                                                |
// |==========+==========+============================================================================|
// | ERROR    |     21:5 | no-unused-private-class-members, '#autoConfigPath' is defined but never    |
// |          |          | used.                                                                      |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |     22:5 | no-unused-private-class-members, '#recoverySignalPath' is defined but never|
// |          |          |  used.                                                                     |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |     27:5 | no-unused-private-class-members, '#recoveryConfigPath' is defined but never|
// |          |          |  used.                                                                     |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |   235:11 | no-unused-private-class-members, '#startCluster' is defined but never used.|
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |   253:18 | no-undef, 'hasStandbySignal' is not defined.                               |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |   360:11 | no-unused-private-class-members, '#startStandby' is defined but never used.|
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |   513:80 | no-undef, 'SYNCHRONOUS_NAME' is not defined.                               |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |  520:233 | no-undef, 'SYNCHRONOUS_NAME' is not defined.                               |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |  529:233 | no-undef, 'ASYNCHRONOUS_NAME' is not defined.                              |
// +----------+----------+----------------------------------------------------------------------------+
// -----END LINT LOG-----
