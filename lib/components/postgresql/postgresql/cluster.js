import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Api from "#core/api";
import ServiceDiscovery from "#core/api/service-discovery";
import RandomValues from "#core/crypto/random-values";
import { pathExists } from "#core/fs";
import sql from "#core/sql";
import LifecycleManager from "#core/threads/lifecycle-manager";
import { TmpDir, TmpFile } from "#core/tmp";
import utils from "./utils.js";

const DEFAULT_STDIO = "ignore", // "inherit",
    SYNCHRONOUS_NAME = "synchronous",
    ASYNCHRONOUS_NAME = "asynchronous";

export default class PostgresqlCluster {
    #postgresql;
    #app;
    #version;
    #name;
    #binDir;
    #clusterDir;
    #dataDir;
    #configPath;
    #autoConfigPath;
    #standbySignalPath;
    #defaultConfigPath;
    #userConfigPath;
    #replicationConfigPath;
    // eslint-disable-next-line no-unused-private-class-members
    #recoverySignalPath;
    // eslint-disable-next-line no-unused-private-class-members
    #recoveryConfigPath;
    #slotId;
    #lifecycleManager;
    #api;
    #remoteAddress;

    constructor ( postgresql, version, name ) {
        this.#postgresql = postgresql;
        this.#app = postgresql.app;
        this.#version = version;
        this.#name = name;

        this.#binDir = path.join( "/usr/lib/postgresql", String( this.#version ), "bin" );
        this.#clusterDir = path.join( this.#postgresql.dataDir, "clusters", this.#name );
        this.#dataDir = path.join( this.#clusterDir, String( this.#version ) );
        this.#configPath = path.join( this.#dataDir, "postgresql.conf" );
        this.#autoConfigPath = path.join( this.#dataDir, "postgresql.auto.conf" );
        this.#standbySignalPath = path.join( this.#dataDir, "standby.signal" );
        this.#defaultConfigPath = path.join( this.#dataDir, "conf.d/0-postgresql.conf" );
        this.#userConfigPath = path.join( this.#dataDir, "conf.d/10-user.conf" );
        this.#replicationConfigPath = path.join( this.#dataDir, "conf.d/20-replication.conf" );
        this.#recoverySignalPath = path.join( this.#dataDir, "recovery.signal" );
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
            this.#spawnSync( `${ this.binDir }/pg_ctl`, [

                //
                "stop",
                `--pgdata=${ this.#dataDir }`,
                "--wait",
                "--mode=immediate",
            ] ) );
    }

    // properties
    get app () {
        return this.#postgresql.app;
    }

    get postgresql () {
        return this.#postgresql;
    }

    get config () {
        return this.#postgresql.config;
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

    get instanceId () {
        return this.#app.env.instanceId;
    }

    get slotId () {
        this.#slotId ??= this.#postgresql.app.env.instanceId.replaceAll( "-", "_" );

        return this.#slotId;
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
            "instanceId": this.instanceId,
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
            "instanceId": this.instanceId,
            "remoteAddress": this.#remoteAddress,
            "status": "stopped",
            "role": null,
            timeline,
            lsn,
        } );
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async #stop () {
        await this.#stopClusterFast();

        return result( 200 );
    }

    #onManagerConnect () {}

    #onManagerDisconnect () {}

    // XXX
    async #onClusterUpdate ( { instanceId, status, role, replicationHost } ) {
        console.log( "[postgresql]", { instanceId, status, role, replicationHost } );

        if ( instanceId !== this.instanceId ) return;

        let res;

        // start cluster
        if ( status === "start" ) {
            if ( role === "primary" ) {
                res = await this.#startPrimary();
            }
            else {
                res = await this.#startStandby( role, replicationHost );
            }

            if ( res.ok ) {
                await this.#api.call( "postgresql/set-instance-status", {
                    "instanceId": this.instanceId,
                    "remoteAddress": this.#remoteAddress,
                    "status": "started",
                    role,
                } );
            }
            else {
                await this.#api.call( "postgresql/set-instance-status", {
                    "instanceId": this.instanceId,
                    "remoteAddress": this.#remoteAddress,
                    "status": "stopped",
                    role,
                } );
            }
        }

        // stop cluster
        else if ( status === "stop" ) {
            await this.#stopClusterFast();

            await this.#api.call( "postgresql/set-instance-status", {
                "instanceId": this.instanceId,
                "remoteAddress": this.#remoteAddress,
                "status": "stopped",
                "role": null,
            } );
        }
    }

    async #hasDataDir () {
        return pathExists( this.dataDir );
    }

    async #hasStandbySignal () {
        return pathExists( this.#standbySignalPath );
    }

    async #prepareCluster ( { signal } = {} ) {
        let res;

        // init cluster dir
        await utils.mkdir( this.#clusterDir );

        if ( await this.#hasDataDir() ) {
            const hasStandbySignal = await this.#hasStandbySignal();

            try {

                // update configs
                await this.#writeConfigs();
                await this.#deleteReplicationConfig();

                // start recovery
                res = await this.#spawnPgCtl( "start", {
                    "options": {
                        "listen_addresses": "",
                        "archive_mode": "off",
                        "archive_command": "/bin/true",
                    },
                    signal,
                } );
                if ( !res.ok ) return res;

                // get timeline, lsn
                const dbh = sql.new( "postgresql:" );
                res = await dbh.selectRow( sql`SELECT timeline_id AS timeline, pg_current_wal_flush_lsn() AS lsn FROM pg_control_checkpoint()` );
                dbh.forceDestroy();

                // stop cluster
                await this.#stopClusterFast();

                return res;
            }
            finally {

                // restore stanby signal
                if ( hasStandbySignal ) {
                    await this.#writeStandbySignal();
                }
            }
        }
        else {
            return result( 200, {
                "timeline": 0,
                "lsn": "",
            } );
        }
    }

    async #startPrimary ( { signal } = {} ) {
        let res;

        // init cluster
        if ( !( await this.#hasDataDir() ) ) {
            res = await this.#initDatabase();
            if ( !res.ok ) return res;
        }

        const hasStandbySignal = await this.#hasStandbySignal();

        // write configs
        await this.#writeConfigs();
        await this.#writeReplicationConfig( {
            "role": "primary",
        } );

        // start server
        res = await this.#spawnPgCtl( "start" );
        if ( !res.ok ) return res;

        // promote standby
        if ( hasStandbySignal ) {
            res = await this.#spawnPgCtl( "promote" );
            if ( !res.ok ) return res;
        }

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

    // XXX configs
    async #startStandby ( role, replicationHost, { signal } = {} ) {
        let res;

        // rewind
        if ( await this.#hasDataDir() ) {

            // XXX
            await this.#deleteReplicationConfig();

            // create replication slot
            res = await this.#checkReplicationSlot( replicationHost );
            if ( !res.ok ) return res;

            // rewind
            const proc = await this.#spawn(
                `${ this.#binDir }/pg_rewind`,
                [

                    //
                    `--target-pgdata=${ this.#dataDir }`,
                    `--source-server=host=${ replicationHost } port=${ 5432 } user=${ this.config.replication.username } dbname=postgres`,
                ],
                {
                    "env": {
                        ...process.env,
                        "PGPASSWORD": this.#postgresql.config.replication.password,
                    },
                    signal,
                }
            );

            res = await new Promise( resolve => proc.once( "close", code => resolve( code
                ? result( 500 )
                : result( 200 ) ) ) );

            // rewind failed
            if ( !res.ok ) {
                if ( signal?.aborted ) return res;

                res = await this.#makeBaseBackup( replicationHost, { signal } );
                if ( !res.ok ) return res;
            }
        }

        // make base backup
        else {
            res = await this.#makeBaseBackup( replicationHost, { signal } );
            if ( !res.ok ) return res;
        }

        // write configs
        await this.#writeConfigs();
        await this.#writeReplicationConfig( {
            role,
            replicationHost,
        } );

        // start server
        res = await this.#spawnPgCtl( "start", { signal } );
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async #makeBaseBackup ( replicationHost, { signal } = {} ) {
        let res;

        // delete replication slot
        res = await this.#checkReplicationSlot( replicationHost, { "deleteSlot": true } );
        if ( !res.ok ) return res;

        const tmpDir = new TmpDir();

        try {
            await utils.mkdir( tmpDir.path );

            const proc = this.#spawn(
                `${ this.#binDir }/pg_basebackup`,
                [

                    //
                    `--host=${ replicationHost }`,
                    "--port=5432",
                    `--pgdata=${ tmpDir.path }`,
                    `--username=${ this.config.replication.username }`,
                    "--no-password",
                    "--wal-method=stream",

                    "--create-slot",
                    `--slot=${ this.slotId }`,

                    // "--progress",
                    // "--verbose",
                    // "--write-recovery-conf",
                ],
                {
                    "env": {
                        ...process.env,
                        "PGPASSWORD": this.config.replication.password,
                    },
                    signal,
                }
            );

            res = await new Promise( resolve => proc.once( "close", code => resolve( code
                ? result( 500 )
                : result( 200 ) ) ) );

            if ( res.ok ) {
                let dataDirBackup, restore;

                if ( await this.#hasDataDir() ) {
                    dataDirBackup = new TmpDir();
                }

                try {

                    // create data dir backup
                    if ( dataDirBackup ) {
                        await fs.promises.rename( this.dataDir, dataDirBackup.path );

                        restore = true;
                    }

                    // move base backup to data dir
                    await fs.promises.rename( tmpDir.path, this.dataDir );

                    // remove data dir backup
                    if ( dataDirBackup ) {
                        restore = false;

                        await dataDirBackup.destroy();
                    }
                }
                catch {

                    // restore data dir backup
                    if ( restore ) {
                        await fs.promises.rename( dataDirBackup.path, this.dataDir );
                    }
                }
            }

            return res;
        }
        finally {
            await tmpDir.destroy();
        }
    }

    async #checkReplicationSlot ( replicationHost, { deleteSlot } = {} ) {
        let res;

        const dbh = sql.new( "postgresql:", {
            "username": this.config.replication.username,
            "password": this.config.replication.password,
            "hostname": replicationHost,
            "port": 5432,
            "database": "postgres",
        } );

        // check replication slot
        try {

            // get replication slot
            res = await dbh.selectRow( sql`SELECT * FROM pg_replication_slots WHERE slot_name = ?`, [ this.slotId ] );
            if ( !res.ok ) return res;

            if ( deleteSlot ) {

                // replication slot exists
                if ( res.data ) {

                    // delete replication slot
                    res = await dbh.selectRow( sql`SELECT pg_drop_replication_slot( ? )`, [ this.slotId ] );
                    if ( !res.ok ) return res;
                }
            }

            // replication slot is not exists
            else if ( !res.data ) {

                // create replication slot
                res = await dbh.selectRow( sql`SELECT pg_create_physical_replication_slot( ?, true )`, [ this.slotId ] );
                if ( !res.ok ) return res;
            }

            return result( 200 );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

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

    async #initDatabase ( { signal } = {} ) {
        if ( await this.#hasDataDir() ) return result( [ 500, "Cluster already exists" ] );

        const passwordFile = new TmpFile(),
            tmpDir = new TmpDir();

        try {
            const password = Buffer.from( RandomValues.default.getRandomArrayBuffer( 16 ) ).toBase64( { "alphabet": "base64url", "omitPadding": true } );

            await utils.writeFile( passwordFile.path, password );

            await utils.mkdir( tmpDir.path );

            const proc = this.#spawn(
                `${ this.binDir }/initdb`,
                [

                    //
                    "--username=postgres",
                    `--pwfile=${ passwordFile }`,
                    `--pgdata=${ tmpDir.path }`,
                    "--encoding=UTF8",
                    "--locale-provider=icu",
                    "--icu-locale=und",
                    "--lc-collate=C.UTF-8",
                    "--lc-ctype=C.UTF-8",
                ],
                {
                    signal,
                }
            );

            const res = await new Promise( resolve => proc.once( "close", code => resolve( code
                ? result( 500 )
                : result( 200 ) ) ) );

            if ( res.ok ) {
                await fs.promises.rename( tmpDir.path, this.dataDir );
            }

            return res;
        }
        finally {
            await passwordFile.destroy();
            await tmpDir.destroy();
        }
    }

    async #writeConfigs () {
        await this.#writeHbaConfig();

        await this.#writeUserConfig();
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

    async #writeReplicationConfig ( { role, replicationHost } = {} ) {
        await this.#initConfigDir();

        await this.#deleteReplicationConfig( {
            "keepStandbySignal": true,
        } );

        let config;

        // primary
        if ( role === "primary" ) {
            config = {
                "wal_level": "replica",
            };

            // if ( this.config.backup.enabled ) {
            //     config.summarize_wal = true;

            //     // XXX incremental_timeout * 2
            //     // minutes, 10 days
            //     // config.wal_summary_keep_time = 14_400

            //     // // PITR
            //     if ( this.config.backup.pitrEnabled ) {

            //         // config.archive_mode = true;
            //         // config.archive_command = `gzip -9 -c %p > ${ this.backup.walsDir }/%f.gz`;
            //     }
            // }

            const numberOfSynchronousStandbys = this.config.replication.numberOfSynchronousStandbys;

            if ( numberOfSynchronousStandbys ) {
                config.synchronous_standby_names = `${ numberOfSynchronousStandbys } ( ${ SYNCHRONOUS_NAME } )`;
            }
        }

        // syncronous stanby
        else if ( role === "synchronous" ) {
            config = {
                "primary_conninfo": `host=${ replicationHost } port=${ 5432 } user=${ this.config.replication.username } password=${ this.config.replication.password } application_name=${ SYNCHRONOUS_NAME }`,
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
            };
        }

        // asyncronous standby
        else if ( role === "asynchronous" ) {
            config = {
                "primary_conninfo": `host=${ replicationHost } port=${ 5432 } user=${ this.config.replication.username } password=${ this.config.replication.password } application_name=${ ASYNCHRONOUS_NAME }`,
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
            };
        }

        if ( await utils.writeConfig( this.#replicationConfigPath, config ) ) {

            // write standby.signal
            if ( role !== "primary" ) {
                await this.#writeStandbySignal();
            }
        }
    }

    async #initConfigDir () {

        // create "conf.d" dir
        if ( !( await pathExists( path.join( this.dataDir, "conf.d" ) ) ) ) {
            await fs.promises.mkdir( path.join( this.dataDir, "conf.d" ), { "recursive": true } );
            await utils.chmodDir( path.join( this.dataDir, "conf.d" ) );

            // move postgresql config
            await fs.promises.rename( this.#configPath, this.#defaultConfigPath );
            await utils.chmodFile( this.#defaultConfigPath );

            // rewrite postgresql config
            await utils.writeFile( this.#configPath, "include_dir = 'conf.d'\n" );
        }
    }

    async #writeStandbySignal () {
        return utils.writeFile( this.#standbySignalPath, "" );
    }

    async #deleteReplicationConfig ( { keepStandbySignal } = {} ) {

        // remove replication config
        await fs.promises.rm( this.#replicationConfigPath, { "force": true } );

        // remove stanby.signal
        if ( !keepStandbySignal ) {
            await fs.promises.rm( this.#standbySignalPath, { "force": true } );
        }

        // remove replication auto config
        if ( await pathExists( this.#autoConfigPath ) ) {
            const config = fs
                .readFileSync( this.#autoConfigPath, "utf8" )
                .split( "\n" )
                .map( line => line.trim() )
                .filter( line => {
                    if ( line.startsWith( "primary_conninfo" ) ) return false;

                    if ( line.startsWith( "primary_slot_name" ) ) return false;

                    return true;
                } )
                .join( "\n" );

            await utils.writeFile( this.#autoConfigPath, config );
        }
    }

    async #spawnPgCtl ( command, { wait = true, timeout = 86_400, mode, options, stdio = DEFAULT_STDIO } = {} ) {
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

    #spawn ( command, args, { cwd, stdio = DEFAULT_STDIO, env, uid = true, signal } = {} ) {
        const options = {
            cwd,
            stdio,
            env,
            signal,
        };

        if ( uid ) {
            options.uid = utils.uid;
            options.gid = utils.gid;
        }

        return childProcess.spawn( command, args, options );
    }

    #spawnSync ( command, args, { cwd, stdio = DEFAULT_STDIO, env, uid = true, signal } = {} ) {
        const options = {
            cwd,
            stdio,
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
