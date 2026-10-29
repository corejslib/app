import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import RandomValues from "#core/crypto/random-values";
import { pathExists, pathExistsSync } from "#core/fs";
import { tryConnect } from "#core/net";
import sql from "#core/sql";
import DbhPostgreSql from "#core/sql/dbh/postgresql";
import LifecycleManager from "#core/threads/lifecycle-manager";
import { TmpFile } from "#core/tmp";
import { sleep } from "#core/utils";
import utils from "./utils.js";

const SYNCHRONOUS_NAME = "synchronous",
    ASYNCHRONOUS_NAME = "asynchronous";

const REPLICATION_TIMEOUT = 10_000,
    LOCAL_TIMEOUT = 10_000;

export default class PostgreSqlCluster {
    #slotId;
    #postgresql;
    #name;
    #version;
    #binDir;
    #dataDir;
    #backupsDir;
    #configPath;
    #autoConfigPath;
    #recoverySignalPath;
    #standbySignalPath;
    #defaultConfigPath;
    #userConfigPath;
    #replicationConfigPath;
    #recoveryConfigPath;
    #postgresqlProcess;
    #lifecycleManager;

    constructor ( postgresql, version, name ) {
        this.#postgresql = postgresql;
        this.#name = name;
        this.#version = Number( version );

        this.#binDir = path.join( "/usr/lib/postgresql", String( this.#version ), "bin" );
        this.#dataDir = path.join( this.#postgresql.dataDir, "clusters", String( this.#version ), this.#name );
        this.#backupsDir = path.join( this.#postgresql.dataDir, "backups", String( this.#version ), this.#name );

        this.#configPath = this.#dataDir + "/postgresql.conf";
        this.#autoConfigPath = this.#dataDir + "/postgresql.auto.conf";
        this.#recoverySignalPath = this.#dataDir + "/recovery.signal";
        this.#standbySignalPath = this.#dataDir + "/standby.signal";
        this.#defaultConfigPath = this.#dataDir + "/conf.d/0-postgresql.conf";
        this.#userConfigPath = this.#dataDir + "/conf.d/10-user.conf";
        this.#replicationConfigPath = this.#dataDir + "/conf.d/20-replication.conf";
        this.#recoveryConfigPath = this.#dataDir + "/conf.d/30-recovery.conf";

        this.#lifecycleManager = new LifecycleManager( {
            "onStart": this.#start.bind( this ),
            "onStop": this.#stop.bind( this ),
            "onDestroyThreads": this.#forceStop.bind( this ),
        } );

        process.once( "exit", () => this.#stopImmediate() );
    }

    // properties
    get postgresql () {
        return this.#postgresql;
    }

    get config () {
        return this.#postgresql.config;
    }

    get slotId () {
        this.#slotId ??= this.#postgresql.app.env.instanceId.replaceAll( "-", "_" );

        return this.#slotId;
    }

    get name () {
        return this.#name;
    }

    get version () {
        return this.#version;
    }

    get isExists () {
        return pathExistsSync( this.dataDir + "/PG_VERSION" );
    }

    get binIsExists () {
        return pathExistsSync( this.#binDir );
    }

    get binDir () {
        return this.#binDir;
    }

    get dataDir () {
        return this.#dataDir;
    }

    get backupsDir () {
        return this.#backupsDir;
    }

    get autoConfigPath () {
        return this.#autoConfigPath;
    }

    get isStarted () {
        return this.#lifecycleManager.isStarted;
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

    async upgrade ( oldClusterVersion, clusterName ) {
        let res;

        clusterName ||= this.config.clusterName;

        const oldCluster = new this.constructor( this.postgresql, oldClusterVersion, clusterName );

        // check old cluster data dir is exitsts
        if ( !oldCluster.isExists ) {
            return result( [ 500, "Old postgres cluster not found" ] );
        }

        // check new cluster is not exists
        if ( this.isExists ) {
            console.log( `
========================================

New cluster data directory already exysts.
Remove it manually and try again:

rm -rf ${ this.dataDir }

========================================
` );

            return result( 500 );
        }

        // install dependencies
        if ( !oldCluster.binIsExists ) {
            res = await this.#exec( "apt", [ "update" ], {
                "stdio": "inherit",
                "uid": false,
            } );
            if ( !res.ok ) return res;

            res = await this.#exec(
                "apt-get",
                [

                    //
                    "install",
                    "-y",
                    `postgresql-${ oldCluster.version }`,
                    ...( process.env.POSTGIS_VERSION
                        ? [ `postgresql-${ oldCluster.version }-postgis-${ process.env.POSTGIS_VERSION }` ]
                        : [] ),
                ],
                {
                    "stdio": "inherit",
                    "uid": false,
                }
            );
            if ( !res.ok ) return res;
        }

        // init new cluster
        res = await this.#initDatabase();
        if ( !res.ok ) return res;

        // remove replication config, required if we upgrading standby
        await oldCluster.#deleteReplicationConfig();

        // check
        res = await this.#exec(
            `${ this.binDir }/pg_upgrade`,
            [

                //
                "--check",
                `--old-bindir=${ oldCluster.binDir }`,
                `--new-bindir=${ this.binDir }`,
                `--old-datadir=${ oldCluster.dataDir }`,
                `--new-datadir=${ this.dataDir }`,
            ],
            {
                "cwd": this.dataDir,
                "stdio": "inherit",
            }
        );
        if ( !res.ok ) return res;

        // upgrade
        res = await this.#exec(
            `${ this.binDir }/pg_upgrade`,
            [

                //
                `--old-bindir=${ oldCluster.binDir }`,
                `--new-bindir=${ this.binDir }`,
                `--old-datadir=${ oldCluster.dataDir }`,
                `--new-datadir=${ this.dataDir }`,
                "--new-options=-c timescaledb.restoring=on''",
            ],
            {
                "cwd": this.dataDir,
                "stdio": "inherit",
            }
        );
        if ( !res.ok ) return res;

        // copy configs
        if ( await pathExists( oldCluster.autoConfigPath ) ) {
            await fs.promises.cp( oldCluster.autoConfigPath, this.autoConfigPath );
        }

        console.log( `
========================================

Cluster upgraded to the version: ${ this.version }.
Old cluster version ${ oldCluster.version } can be removed.

Run manually, aftes server started:

vacuumdb --all --analyze-in-stages --missing-stats-only
vacuumdb --all --analyze-only

========================================
` );

        return result( 200 );
    }

    // XXX review, require for restore
    async writeReRecoveryConfig () {
        await this.deleteRecoveryConfig();

        const config = {

            // XXX recovery_target_time = 'YYYY-MM-DD HH:MM:SS' # Or recovery_target_xid, recovery_target_name, etc.
            "recovery_target_time": "",

            // "restore_command": `gunzip -c ${ this.backup.walsDir }/%f.gz > %p`,
            // "restore_command": `curl "http://postgres-backup:81/rpc/postgresql/get-wal?file=%f" --output "%p"`,
            // "recovery_end_command": null,
            "recovery_target_inclusive": true,
        };

        if ( await utils.writeConfig( this.#recoveryConfigPath, config ) ) {

            // create recovery.signal
            await utils.writeFile( this.#recoverySignalPath, "" );
        }
    }

    // XXX review, require for restore
    async deleteRecoveryConfig () {
        return Promise.all( [

            //
            fs.promises.rm( this.#recoverySignalPath, { "force": true } ),
            fs.promises.rm( this.#recoveryConfigPath, { "force": true } ),
        ] );
    }

    on ( event, callback ) {
        this.#lifecycleManager.on( event, callback );

        return this;
    }

    once ( event, callback ) {
        this.#lifecycleManager.once( event, callback );

        return this;
    }

    off ( event, callback ) {
        this.#lifecycleManager.off( event, callback );

        return this;
    }

    // private
    async #start ( signal ) {
        let res;

        this.#log( "Starting server, mode: " + this.#postgresql.mode );

        // start primary
        if ( this.#postgresql.isPrimary ) {
            res = await this.#startPrimary( signal );
        }
        else if ( this.#postgresql.isStandby ) {
            res = await this.#startStandby( signal );
        }
        else if ( this.#postgresql.isBackup ) {
            res = await this.#startBackup( signal );
        }
        else {
            return result( 500 );
        }

        if ( res.ok ) {
            this.#log( "Server started" );

            this.#postgresqlProcess = res.data.postgresqlProcess;

            this.#postgresqlProcess.on( "exit", this.#onPostgreSqlExit.bind( this ) );

            return result( 200 );
        }
        else {
            this.#log( "Failed to start server", res );

            return res;
        }
    }

    async #stop ( signal ) {
        if ( this.#postgresqlProcess ) {
            this.#log( "Stopping server" );

            this.#stopFast();

            await this.#waitProcessExit();

            this.#postgresqlProcess = null;
        }

        this.#log( "Server stopped" );

        return result( 200 );
    }

    #forceStop () {
        this.#stopImmediate();
    }

    #stopFast ( postgresqlProcess = this.#postgresqlProcess ) {
        if ( !postgresqlProcess ) return;

        postgresqlProcess.kill( "SIGINT" );
    }

    // eslint-disable-next-line no-unused-private-class-members
    #stopSmart ( postgresqlProcess = this.#postgresqlProcess ) {
        if ( !postgresqlProcess ) return;

        postgresqlProcess.kill( "SIGTERM" );
    }

    #stopImmediate ( postgresqlProcess = this.#postgresqlProcess ) {
        if ( !postgresqlProcess ) return;

        postgresqlProcess.kill( "SIGQUIT" );
    }

    #onPostgreSqlExit () {
        this.#postgresqlProcess = null;

        this.#lifecycleManager.stop();
    }

    async #startPrimary ( signal ) {
        let res;

        // init data dir
        res = await this.#initDataDir();
        if ( !res.ok ) return res;

        // init cluster db
        if ( !this.isExists ) {
            res = await this.#initDatabase();
            if ( !res.ok ) return res;
        }

        // write configs
        await this.#writeHbaConfig();
        await this.#writeUserConfig();

        // update replication role
        this.#log( "Initializing primary server" );
        res = await this.#initPrimary( signal );
        this.#log( "Server initialization status:", res );
        if ( !res.ok ) return res;

        // write configs
        await this.#writeReplicationConfig();

        // start server
        return this.#startPostgresqlProcess( {
            "network": true,
            signal,
        } );
    }

    async #startStandby ( signal ) {
        let res;

        // init data dir
        res = await this.#initDataDir();
        if ( !res.ok ) return res;

        // make base backup
        if ( !this.isExists ) {
            res = await this.#makeBaseBackup( signal );
            if ( !res.ok ) return res;
        }

        // sync with the primary
        else {
            await this.#deleteReplicationConfig();

            // check connection to the primary host
            res = await this.#checkServerReady( {
                "replication": true,
                signal,
                "timeout": REPLICATION_TIMEOUT,
            } );
            if ( !res.ok ) return res;

            // the primary must retain WAL for this standby
            res = await this.#createReplicationSlot();
            if ( !res.ok ) return res;

            // sync
            res = await this.#exec(
                `${ this.#binDir }/pg_rewind`,
                [

                    //
                    "--target-pgdata",
                    this.#dataDir,
                    "--source-server",
                    `host=${ this.#postgresql.replicationHostname } port=${ this.#postgresql.config.replication.port } user=${ this.#postgresql.config.replication.username } dbname=postgres`,
                ],
                {
                    "stdio": "inherit",
                    "env": {
                        ...process.env,
                        "PGPASSWORD": this.#postgresql.config.replication.password,
                    },
                    signal,
                }
            );

            // fallback to the full backup
            if ( !res.ok ) {
                if ( signal?.aborted ) return res;

                res = await this.#rebuildFromBaseBackup( signal );
                if ( !res.ok ) return res;
            }
        }

        // write configs
        await this.#writeHbaConfig();
        await this.#writeUserConfig();
        await this.#writeReplicationConfig();

        // start server
        return this.#startPostgresqlProcess( {
            "network": true,
            signal,
        } );
    }

    async #rebuildFromBaseBackup ( signal ) {
        let res;

        const oldDataDir = this.dataDir + ".old";

        // drop previous leftovers
        await fs.promises.rm( oldDataDir, {
            "force": true,
            "recursive": true,
        } );

        await fs.promises.rename( this.dataDir, oldDataDir );

        res = await this.#initDataDir();

        if ( res.ok ) {
            res = await this.#makeBaseBackup( signal );
        }

        // restore old data dir
        if ( !res.ok ) {
            await this.#removeDataDir();

            await fs.promises.rename( oldDataDir, this.dataDir );

            return res;
        }

        await fs.promises.rm( oldDataDir, {
            "force": true,
            "recursive": true,
        } );

        return res;
    }

    // XXX
    async #startBackup ( signal ) {
        var res;

        // init backups dir
        res = await this.#initBackupsDir();
        if ( !res.ok ) return res;

        return result( 200 );
    }

    async #startPostgresqlProcess ( { network = true, signal, timeout } = {} ) {
        const listen = network
            ? "0.0.0.0"
            : "127.0.0.1";

        const postgresqlProcess = this.#spawn(
            `${ this.#binDir }/postgres`,
            [

                //
                "-D",
                this.#dataDir,
                "-k",
                this.#postgresql.unixSocketDir,
                "-h",
                listen,
            ],
            {
                "stdio": "ignore", // "inherit",
            }
        );

        // stop waiting if the process has exited
        const exitController = new AbortController();

        postgresqlProcess.once( "exit", () => exitController.abort() );

        const res = await this.#checkServerReady( {
            "signal": signal
                ? AbortSignal.any( [ signal, exitController.signal ] )
                : exitController.signal,
            timeout,
        } );

        if ( res.ok ) {
            return result( 200, {
                postgresqlProcess,
            } );
        }
        else {
            this.#stopImmediate( postgresqlProcess );

            await this.#waitProcessExit( postgresqlProcess );

            return res;
        }
    }

    async #waitProcessExit ( postgresqlProcess = this.#postgresqlProcess ) {
        if ( !postgresqlProcess ) return;

        postgresqlProcess.removeAllListeners();

        // not exited
        if ( postgresqlProcess.exitCode == null && postgresqlProcess.signalCode == null ) {
            return new Promise( resolve => postgresqlProcess.once( "exit", resolve ) );
        }
    }

    async #removeDataDir () {
        await fs.promises.rm( this.dataDir, {
            "force": true,
            "recursive": true,
        } );

        return result( 200 );
    }

    async #initDataDir () {

        // init data dir
        await fs.promises.mkdir( this.dataDir, { "recursive": true } );
        await utils.chmodDir( this.dataDir, { "recursive": true } );

        return result( 200 );
    }

    async #initBackupsDir () {

        // init backups dir
        await fs.promises.mkdir( this.backupsDir, { "recursive": true } );
        await utils.chmodDir( this.backupsDir, { "recursive": true } );

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
        if ( this.isExists ) return result( [ 500, "Cluster already exists" ] );

        const password = Buffer.from( RandomValues.default.getRandomArrayBuffer( 16 ) ).toString( "base64url" );

        const passwordFile = new TmpFile();
        await utils.writeFile( passwordFile.path, password );

        const res = await this.#exec(
            `${ this.binDir }/initdb`,
            [

                //
                "--encoding=UTF8",
                "--no-locale",
                "-U",
                "postgres",
                `--pwfile=${ passwordFile }`,
                `--pgdata=${ this.dataDir }`,
            ],
            {
                "stdio": "ignore",
            }
        );

        await passwordFile.destroy();

        return res;
    }

    async #initPrimary ( signal ) {
        let res;

        // the former standby must be promoted explicitly, to switch the timeline
        const isPromotion = await pathExists( this.#standbySignalPath );

        await this.#deleteReplicationConfig();

        // keep standby.signal (without primary_conninfo) until the promotion
        if ( isPromotion ) {
            await utils.writeFile( this.#standbySignalPath, "" );
        }

        res = await this.#startPostgresqlProcess( {
            "network": false,
            signal,
            "timeout": LOCAL_TIMEOUT,
        } );
        if ( !res.ok ) return res;

        const postgresqlProcess = res.data.postgresqlProcess,
            dbh = this.#createDbh();

        if ( isPromotion ) {
            this.#log( "Promoting standby to primary" );

            res = await dbh.selectRow( sql`SELECT pg_promote( true, 60 ) AS promoted` );

            if ( res.ok && !res.data.promoted ) {
                res = result( [ 500, "Promotion timeout" ] );
            }
        }
        else {
            res = result( 200 );
        }

        if ( res.ok ) {
            const query = sql`

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
`;

            res = await dbh.exec( query );
        }

        await dbh.forceDestroy();

        // fast shutdown writes the checkpoint, required after the promotion
        this.#stopFast( postgresqlProcess );
        await this.#waitProcessExit( postgresqlProcess );

        return res;
    }

    async #makeBaseBackup ( signal ) {
        let res;

        this.#log( "Creating base backup" );

        try {

            // check primary ready
            res = await this.#checkServerReady( {
                "replication": true,
                signal,
                "timeout": REPLICATION_TIMEOUT,
            } );
            if ( !res.ok ) return res;

            const dbh = this.#createDbh( { "replication": true } );

            // check replication slot
            try {

                // get replication slot
                res = await dbh.selectRow( sql`SELECT * FROM pg_replication_slots WHERE slot_name = ?`, [ this.slotId ] );
                if ( !res.ok ) return res;

                // delete replication slot if exists
                if ( res.data ) {
                    res = await dbh.selectRow( sql`SELECT pg_drop_replication_slot( ? )`, [ this.slotId ] );
                    if ( !res.ok ) return res;
                }
            }
            finally {
                await dbh.forceDestroy();
            }

            res = await this.#exec(
                `${ this.#binDir }/pg_basebackup`,
                [

                    //
                    "--host=" + this.#postgresql.replicationHostname,
                    "--port=" + this.#postgresql.config.replication.port,
                    "--pgdata=" + this.#dataDir,
                    "--username=" + this.#postgresql.config.replication.username,
                    "--no-password",
                    "--wal-method=stream",

                    "--create-slot",
                    "--slot=" + this.slotId,

                    // "--progress",
                    // "--verbose",
                    // "--write-recovery-conf",
                ],
                {
                    "stdio": "inherit",
                    "env": {
                        ...process.env,
                        "PGPASSWORD": this.#postgresql.config.replication.password,
                    },
                    signal,
                }
            );

            return res;
        }
        finally {
            this.#log( "Base backup creation status:", res );
        }
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

    async #createReplicationSlot () {
        let res;

        const dbh = this.#createDbh( { "replication": true } );

        try {
            res = await dbh.selectRow( sql`SELECT 1 FROM pg_replication_slots WHERE slot_name = ?`, [ this.slotId ] );
            if ( !res.ok ) return res;

            if ( !res.data ) {
                res = await dbh.selectRow( sql`SELECT pg_create_physical_replication_slot( ?, true )`, [ this.slotId ] );
            }

            return res;
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    #createDbh ( { replication } = {} ) {
        const url = new URL( "postgresql://" ),
            options = {
                "maxConnections": 1,
            };

        if ( replication ) {
            url.hostname = this.postgresql.replicationHostname;
            url.port = this.config.replication.port;

            options.username = this.config.replication.username;
            options.password = this.config.replication.password;
            options.database = "postgres";
        }

        return sql.new( url, options );
    }

    async #checkServerReady ( { replication, signal, timeout } = {} ) {
        let ready = false,
            timer,
            exitOnTimeout,
            dbh,
            res;

        try {
            if ( timeout ) {
                timer = setTimeout( () => {
                    exitOnTimeout = true;
                }, timeout );
            }

            // check socket
            while ( !signal?.aborted && !exitOnTimeout ) {
                if ( replication ) {
                    ready = await tryConnect( {
                        "host": this.postgresql.replicationHostname,
                        "port": this.config.replication.port,
                        signal,
                    } );
                }
                else {
                    ready = await tryConnect( {
                        "path": DbhPostgreSql.createUnixSocketPath(),
                        signal,
                    } );
                }

                if ( ready ) break;

                await sleep( 100 );
            }

            if ( !ready ) {
                if ( signal?.aborted ) {
                    return result( [ 500, "Aborted" ] );
                }
                else {
                    return result( [ 500, "PostgreSql socket closed" ] );
                }
            }

            dbh = this.#createDbh( {
                replication,
            } );

            while ( !signal?.aborted && !exitOnTimeout ) {
                res = await dbh.selectRow( "SELECT 1" );

                if ( res.ok ) break;

                await sleep( 100 );
            }

            if ( res?.ok ) {
                return result( 200 );
            }
            else {
                if ( signal?.aborted ) {
                    return result( [ 500, "Aborted" ] );
                }
                else {
                    return res ?? result( [ 500, "PostgreSql is not ready, timeout" ] );
                }
            }
        }
        finally {
            clearTimeout( timer );

            await dbh?.forceDestroy();
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

    async #exec ( ...args ) {
        return new Promise( resolve => {
            const proc = this.#spawn( ...args );

            proc.once( "error", e => resolve( result( [ 500, e.message ] ) ) );

            proc.once( "exit", code => {
                if ( code === 0 ) {
                    resolve( result( 200 ) );
                }
                else {
                    resolve( result( 500 ) );
                }
            } );
        } );
    }

    #log ( message, res ) {
        if ( res ) {
            console.log( "[postgresql]", message, res.statusText );
        }
        else {
            console.log( "[postgresql]", message );
        }
    }
}
