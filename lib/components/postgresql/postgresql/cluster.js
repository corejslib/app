import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import RandomValues from "#core/crypto/random-values";
import { pathExists } from "#core/fs";
import sql from "#core/sql";
import LifecycleManager from "#core/threads/lifecycle-manager";
import { TmpDir, TmpFile } from "#core/tmp";
import { sleep } from "#core/utils";
import utils, { ASYNCHRONOUS_NAME, PRIMARY_NAME, SYNCHRONOUS_NAME } from "./utils.js";

const DEFAULT_STDIO = "ignore", // "inherit",
    REPLAY_POLL_INTERVAL = 1000,
    REPLAY_STABLE_CHECKS = 3,
    REPLAY_STALL_TIMEOUT = 600_000,
    POSTGRESQL_PORT = 5432,
    POSTMASTER_PID_FILE = "postmaster.pid",
    MONITOR_INTERVAL = 1000,
    SLOT_DROP_ATTEMPTS = 10,
    SLOT_DROP_INTERVAL = 1000,
    STDERR_MAX_LENGTH = 4096,
    STDERR_STDIO = [ "ignore", "ignore", "pipe" ];

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
    #recoverySignalPath;
    // eslint-disable-next-line no-unused-private-class-members
    #recoveryConfigPath;
    #rewindMarkerPath;
    #recoveryMarkerPath;
    #monitorTimer;
    #slotId;
    #lifecycleManager;
    #status = "stopped";
    #busy = false;
    #role = null;
    #timeline = null;
    #lsn = null;
    #history = null;

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
        this.#rewindMarkerPath = path.join( this.#clusterDir, "rewind.in-progress" );
        this.#recoveryMarkerPath = path.join( this.#clusterDir, "recovery.in-progress" );

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

    async getStatus () {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        return result( 200, {
            "status": this.#status,
            "busy": this.#busy,
            "role": this.#role,
            "timeline": this.#timeline,
            "lsn": this.#lsn,
            "history": this.#history,
            "standby": await this.#hasStandbySignal(),
        } );
    }

    async recoverCluster () {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        if ( this.#busy ) return result( [ 500, "Cluster is busy" ] );

        if ( this.#status !== "stopped" ) return result( [ 500, "Cluster is started" ] );

        this.#lifecycleManager.beginActivity();

        this.#busy = true;
        this.#status = "recovering";

        const res = await this.#recoverCluster();

        this.#status = "stopped";
        this.#busy = false;
        this.#role = null;

        if ( res.ok ) {
            this.#timeline = res.data.timeline;
            this.#lsn = res.data.lsn;
            this.#history = res.data.history;
        }
        else {
            this.#timeline = null;
            this.#lsn = null;
            this.#history = null;
        }

        const status = await this.getStatus();
        res.data = status.data;

        this.#lifecycleManager.endActivity();

        return res;
    }

    async startCluster ( role, { replicationHostname } ) {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        if ( this.#busy ) return result( [ 500, "Cluster is busy" ] );

        if ( this.#status !== "stopped" ) return result( [ 500, "Cluster is started" ] );

        this.#lifecycleManager.beginActivity();

        this.#busy = true;
        this.#status = "starting";

        let res;

        if ( role === PRIMARY_NAME ) {
            res = await this.#startPrimary();
        }
        else {
            res = await this.#startStandby( role, replicationHostname );
        }

        this.#busy = false;
        this.#timeline = null;
        this.#lsn = null;
        this.#history = null;

        if ( res.ok ) {
            this.#status = "started";
            this.#role = role;

            // monitor postgres process
            await this.#startMonitor();

            // register on service-discovery
            this.app.cluster.serviceDiscovery.addService( `postgresql-${ this.#role }`, POSTGRESQL_PORT );
        }
        else {
            this.#status = "stopped";
            this.#role = null;
        }

        const status = await this.getStatus();
        res.data = status.data;

        this.#lifecycleManager.endActivity();

        return res;
    }

    async stopCluster () {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        if ( this.#busy ) return result( [ 500, "Cluster is busy" ] );

        this.#lifecycleManager.beginActivity();

        this.#busy = true;
        this.#status = "stopping";

        const res = await this.#stopClusterFast();

        // unregister on service-discovery
        this.app.cluster.serviceDiscovery.addService( `postgresql-${ this.#role }`, POSTGRESQL_PORT );

        this.#busy = false;
        this.#status = "stopped";
        this.#role = null;
        this.#timeline = null;
        this.#lsn = null;
        this.#history = null;

        const status = await this.getStatus();
        res.data = status.data;

        this.#lifecycleManager.endActivity();

        return res;
    }

    // private
    async #start ( signal ) {

        // standby.signal, created by the interrupted recovery, must not turn the primary into a standby
        await this.#discardTemporaryStandbySignal();

        // register on service-discovery
        this.app.cluster.serviceDiscovery.addService( "postgresql-instance-rpc", this.app.components.get( "privateHttpServer" ).port, {
            "pathname": this.app.rpc.config.frontend.location,
        } );

        return result( 200 );
    }

    async #stop ( signal ) {

        // unregister service-discovery
        this.app.cluster.serviceDiscovery.deleteService( "postgresql-instance-rpc" );

        // stop cluster
        await this.#stopClusterFast();

        return result( 200 );
    }

    async #hasDataDir () {
        return pathExists( this.dataDir );
    }

    async #hasStandbySignal () {
        return pathExists( this.#standbySignalPath );
    }

    // recovery of the cluster without standby.signal (former primary) creates standby.signal temporarily, the marker is created before the signal and removed after it,
    // so if the process was interrupted in between, the signal can be safely removed on the next operation
    async #discardTemporaryStandbySignal () {
        if ( !( await pathExists( this.#recoveryMarkerPath ) ) ) return;

        await this.#deleteStandbySignal();

        await fs.promises.rm( this.#recoveryMarkerPath, { "force": true } );
    }

    // replays all local wal of the cluster and returns timeline and lsn of the end of this wal
    // primary and standby are recovered in the same way, as a standby: the server replays local wal, stays in recovery, so it does not write anything to wal, and is stopped by the restartpoint
    // the lsn is the end of the valid local wal and is the same for a primary and for a standby
    async #recoverCluster ( { signal } = {} ) {
        let res, timeline, needStop;

        // init cluster dir
        await utils.mkdir( this.#clusterDir );

        await this.#discardBrokenDataDir();
        await this.#discardTemporaryStandbySignal();

        // cluster is not initialized
        if ( !( await this.#hasDataDir() ) ) {
            return result( 200, {
                "timeline": 0,
                "lsn": "",
                "history": [],
            } );
        }

        const hasStandbySignal = await this.#hasStandbySignal();

        try {

            // update configs
            await this.#writeConfigs();

            // standby.signal is kept, otherwise standby will be recovered as a primary, and its wal will diverge from the primary wal
            await this.#deleteReplicationConfig( {
                "keepStandbySignal": true,
            } );

            // recovery.signal turns recovery into archive recovery and creates a new timeline
            await this.#deleteRecoverySignal();

            // former primary is recovered as a standby, standby.signal is temporary
            if ( !hasStandbySignal ) {
                await utils.writeFile( this.#recoveryMarkerPath, "" );

                await this.#writeStandbySignal();
            }

            needStop = true;

            // start recovery
            res = await this.#spawnPgCtl( "start", {
                "options": {
                    "listen_addresses": "",
                    "archive_mode": "off",
                    "archive_command": "/bin/true",
                    "primary_conninfo": "",
                    "primary_slot_name": "",
                    "restore_command": "",
                    "hot_standby": "on",
                    "wal_log_hints": "on",
                },
                signal,
            } );
            if ( !res.ok ) return res;

            // wait until all local wal is replayed
            res = await this.#waitReplay( { signal } );
            if ( !res.ok ) return res;

            const lsn = res.data.lsn;

            // stop cluster
            res = await this.#stopClusterFast();
            if ( !res.ok ) return res;

            needStop = false;

            // get timeline
            res = await this.#getControlData();
            if ( !res.ok ) return res;

            const controlData = res.data,
                state = controlData[ "Database cluster state" ];

            if ( state !== "shut down in recovery" ) return result( [ 500, `Unexpected cluster state: ${ state }` ] );

            // timeline of the last checkpoint can lag behind the replay timeline
            timeline = Math.max( Number( controlData[ "Latest checkpoint's TimeLineID" ] ), Number( controlData[ "Min recovery ending loc's timeline" ] || 0 ) );

            if ( !Number.isInteger( timeline ) || timeline < 1 ) return result( [ 500, `Invalid timeline: ${ timeline }` ] );

            // history is required to check, whether the timelines are descendants of each other
            res = await this.#readTimelineHistory( timeline );
            if ( !res.ok ) return res;

            return result( 200, {
                timeline,
                lsn,
                "history": res.data,
            } );
        }
        catch ( e ) {
            return result( [ 500, e.message ] );
        }
        finally {

            // server can stay running after an error or abort
            if ( needStop ) {
                await this.#stopClusterImmediate();
            }

            // remove temporary standby.signal
            await this.#discardTemporaryStandbySignal();
        }
    }

    async #startPrimary ( { signal } = {} ) {
        let res, needStop;

        try {
            await this.#discardBrokenDataDir();
            await this.#discardTemporaryStandbySignal();

            // init cluster
            if ( !( await this.#hasDataDir() ) ) {
                res = await this.#initDatabase( { signal } );
                if ( !res.ok ) return res;
            }

            // standby.signal means, that the cluster is a standby and must be promoted
            const hasStandbySignal = await this.#hasStandbySignal();

            // write configs
            await this.#writeConfigs();
            await this.#writeReplicationConfig( PRIMARY_NAME );

            // server can stay running after an error or abort
            needStop = true;

            // start server
            res = await this.#spawnPgCtl( "start", { signal } );
            if ( !res.ok ) return res;

            // promote standby
            if ( hasStandbySignal ) {
                res = await this.#spawnPgCtl( "promote", { signal } );
                if ( !res.ok ) return res;
            }

            // update replication role
            res = await this.#updateReplicationRole();
            if ( !res.ok ) return res;

            // pg_rewind on the old primary reads timeline from the control file, which is updated only by a checkpoint
            if ( hasStandbySignal ) {
                res = await this.#checkpoint();
                if ( !res.ok ) return res;
            }

            needStop = false;

            return result( 200 );
        }
        catch ( e ) {
            return result( [ 500, e.message ] );
        }
        finally {
            if ( needStop ) {
                await this.#stopClusterAfterFailure();
            }
        }
    }

    async #startStandby ( role, replicationHostname, { signal } = {} ) {
        if ( role !== SYNCHRONOUS_NAME && role !== ASYNCHRONOUS_NAME ) return result( [ 400, `Invalid standby role: ${ role }` ] );

        let res, needStop;

        try {
            await this.#discardBrokenDataDir();
            await this.#discardTemporaryStandbySignal();

            // rewind
            if ( await this.#hasDataDir() ) {

                // create replication slot
                res = await this.#checkReplicationSlot( replicationHostname, { signal } );
                if ( !res.ok ) return res;

                res = await this.#rewindDataDir( replicationHostname, { signal } );

                // rewind failed
                if ( !res.ok ) {
                    if ( signal?.aborted ) return res;

                    res = await this.#makeBaseBackup( replicationHostname, { signal } );
                    if ( !res.ok ) return res;
                }
            }

            // make base backup
            else {
                res = await this.#makeBaseBackup( replicationHostname, { signal } );
                if ( !res.ok ) return res;
            }

            // write configs
            await this.#writeConfigs();
            await this.#writeReplicationConfig( role, {
                replicationHostname,
            } );

            // without standby.signal the server will be started as a primary
            if ( !( await this.#hasStandbySignal() ) ) return result( [ 500, "standby.signal is missing" ] );

            // server can stay running after an error or abort
            needStop = true;

            // start server
            res = await this.#spawnPgCtl( "start", { signal } );
            if ( !res.ok ) return res;

            needStop = false;

            return result( 200 );
        }
        catch ( e ) {
            return result( [ 500, e.message ] );
        }
        finally {
            if ( needStop ) {
                await this.#stopClusterAfterFailure();
            }
        }
    }

    // waits until the startup process has replayed all local wal and is waiting for a new wal
    // repeated checks protect only from a race between reading the lsn and the state of the startup process
    async #waitReplay ( { signal } = {} ) {
        const dbh = sql.new( "postgresql:" );

        try {
            let lastLsn,
                stableChecks = 0,
                lastProgress = Date.now();

            while ( !signal?.aborted ) {
                const res = await dbh.selectRow( sql`
SELECT
    pg_catalog.pg_last_wal_replay_lsn() AS lsn,
    pg_catalog.pg_is_in_recovery() AS in_recovery,
    ( SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE backend_type = 'startup' ) AS startup_found,
    ( SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE backend_type = 'startup' AND wait_event IN ( 'RecoveryWalStream', 'RecoveryRetrieveRetryInterval' ) ) AS startup_idle
` );
                if ( !res.ok ) return res;

                if ( !res.data?.in_recovery ) return result( [ 500, "Cluster is not in recovery" ] );

                // the state of the startup process is the only reliable sign, that all local wal is replayed, do not guess by the lsn
                if ( !res.data.startup_found ) return result( [ 500, "Startup process is not found in pg_stat_activity" ] );

                // startup process, that has replayed all local wal, waits for a new wal:
                // RecoveryWalStream - streaming recovery, RecoveryRetrieveRetryInterval - wal is not available from any source (no primary_conninfo and restore_command)
                const lsn = res.data.lsn,
                    idle = res.data.startup_idle > 0;

                if ( lsn !== lastLsn ) {
                    lastLsn = lsn;
                    lastProgress = Date.now();
                    stableChecks = 0;
                }
                else if ( idle ) {
                    stableChecks++;

                    // waiting for a new wal is not a stall
                    lastProgress = Date.now();

                    if ( stableChecks >= REPLAY_STABLE_CHECKS ) {

                        // do not replace the absence of a reliable lsn with a fake value
                        if ( !lsn ) return result( [ 500, "Replay lsn is not available" ] );

                        return result( 200, { lsn } );
                    }
                }
                else {
                    stableChecks = 0;
                }

                if ( Date.now() - lastProgress > REPLAY_STALL_TIMEOUT ) return result( [ 500, "WAL replay is stalled" ] );

                await sleep( REPLAY_POLL_INTERVAL );
            }

            return result( [ 500, "Aborted" ] );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    // timeline history file contains all ancestors of the timeline, one per line: "<ancestor timeline> <lsn, where the history switched to the next timeline> <reason>"
    // the first timeline has no history file
    async #readTimelineHistory ( timeline ) {
        if ( timeline <= 1 ) return result( 200, [] );

        const historyPath = path.join( this.#dataDir, "pg_wal", `${ timeline.toString( 16 ).toUpperCase().padStart( 8, "0" ) }.history` );

        let content;

        try {
            content = await fs.promises.readFile( historyPath, "utf8" );
        }
        catch ( e ) {
            return result( [ 500, `Unable to read timeline history file: ${ e.message }` ] );
        }

        const history = [];

        for ( const line of content.split( "\n" ) ) {
            const trimmed = line.trim();

            if ( !trimmed || trimmed.startsWith( "#" ) ) continue;

            const [ ancestor, lsn ] = trimmed.split( /\s+/v, 2 );

            if ( !/^\d+$/v.test( ancestor ) || !/^[\da-f]+\/[\da-f]+$/iv.test( lsn ) ) return result( [ 500, `Invalid line in timeline history file: ${ trimmed }` ] );

            history.push( {
                "timeline": Number( ancestor ),
                "lsn": lsn.toUpperCase(),
            } );
        }

        // the history of the timeline must have at least one ancestor
        if ( !history.length ) return result( [ 500, "Timeline history file is empty" ] );

        return result( 200, history );
    }

    async #getControlData () {
        const proc = this.#spawn( `${ this.binDir }/pg_controldata`, [ this.#dataDir ], {
            "stdio": [ "ignore", "pipe", "ignore" ],
            "env": {
                ...process.env,
                "LC_ALL": "C",
            },
        } );

        let stdout = "";

        proc.stdout.setEncoding( "utf8" );

        proc.stdout.on( "data", data => {
            stdout += data;
        } );

        const res = await this.#waitProcess( proc );
        if ( !res.ok ) return res;

        const data = {};

        for ( const line of stdout.split( "\n" ) ) {
            const idx = line.indexOf( ":" );

            if ( idx === -1 ) continue;

            data[ line.slice( 0, idx ).trim() ] = line.slice( idx + 1 ).trim();
        }

        return result( 200, data );
    }

    async #updateReplicationRole () {
        const dbh = sql.new( "postgresql:" );

        try {
            return await dbh.exec( sql`
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
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    async #checkpoint () {
        const dbh = sql.new( "postgresql:" );

        try {

            // CHECKPOINT can not be executed inside of a transaction block, so it must be a separate query
            return await dbh.exec( sql`CHECKPOINT` );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    async #rewindDataDir ( replicationHostname, { signal } = {} ) {

        // a failed or interrupted pg_rewind leaves the data dir in an unusable state, the marker is removed only after a successful rewind
        await utils.writeFile( this.#rewindMarkerPath, "" );

        const proc = this.#spawn(
            `${ this.#binDir }/pg_rewind`,
            [

                //
                `--target-pgdata=${ this.#dataDir }`,
                `--source-server=${ this.#getPrimaryConninfo( replicationHostname ) }`,
            ],
            {
                "stdio": STDERR_STDIO,
                "env": {
                    ...process.env,
                    "PGPASSWORD": this.config.replication.password,
                },
                signal,
            }
        );

        const res = await this.#waitProcess( proc );
        if ( !res.ok ) return res;

        // pg_rewind copies configs from the source, remove replication settings of the source
        await this.#deleteReplicationConfig();

        await fs.promises.rm( this.#rewindMarkerPath, { "force": true } );

        return res;
    }

    async #makeBaseBackup ( replicationHostname, { signal } = {} ) {
        let res;

        // delete replication slot
        res = await this.#checkReplicationSlot( replicationHostname, {
            "deleteSlot": true,
            signal,
        } );
        if ( !res.ok ) return res;

        const tmpDir = new TmpDir();

        try {
            await utils.mkdir( tmpDir.path );

            const proc = this.#spawn(
                `${ this.#binDir }/pg_basebackup`,
                [

                    //
                    `--host=${ replicationHostname }`,
                    `--port=${ POSTGRESQL_PORT }`,
                    `--pgdata=${ tmpDir.path }`,
                    `--username=${ this.config.replication.username }`,
                    "--no-password",
                    "--wal-method=stream",
                    "--checkpoint=fast",

                    "--create-slot",
                    `--slot=${ this.slotId }`,

                    // "--progress",
                    // "--verbose",
                    // "--write-recovery-conf",
                ],
                {
                    "stdio": STDERR_STDIO,
                    "env": {
                        ...process.env,
                        "PGPASSWORD": this.config.replication.password,
                    },
                    signal,
                }
            );

            res = await this.#waitProcess( proc );
            if ( !res.ok ) return res;

            return await this.#replaceDataDir( tmpDir.path );
        }
        finally {
            await tmpDir.destroy();
        }
    }

    async #replaceDataDir ( newDataDirPath ) {
        let dataDirBackup, restore;

        try {

            // create data dir backup
            if ( await this.#hasDataDir() ) {
                dataDirBackup = new TmpDir();

                await fs.promises.rename( this.dataDir, dataDirBackup.path );

                restore = true;
            }

            // move base backup to data dir
            await fs.promises.rename( newDataDirPath, this.dataDir );
        }
        catch ( e ) {

            // restore data dir backup
            if ( restore ) {
                try {
                    await fs.promises.rename( dataDirBackup.path, this.dataDir );
                }
                catch ( e_ ) {
                    return result( [ 500, `${ e.message }. Unable to restore data dir backup: ${ e_.message }` ] );
                }
            }

            return result( [ 500, e.message ] );
        }

        // new data dir is in place, the marker is obsolete
        await fs.promises.rm( this.#rewindMarkerPath, { "force": true } );

        // remove data dir backup, failure is not critical
        if ( dataDirBackup ) {
            try {
                await dataDirBackup.destroy();
            }
            catch {}
        }

        return result( 200 );
    }

    async #discardBrokenDataDir () {
        if ( !( await pathExists( this.#rewindMarkerPath ) ) ) return;

        // the marker is removed last, so the operation can be safely repeated
        await fs.promises.rm( this.dataDir, {
            "recursive": true,
            "force": true,
        } );

        await fs.promises.rm( this.#rewindMarkerPath, { "force": true } );
    }

    async #checkReplicationSlot ( replicationHostname, { deleteSlot, signal } = {} ) {
        let res;

        const dbh = sql.new( "postgresql:", {
            "username": this.config.replication.username,
            "password": this.config.replication.password,
            "hostname": replicationHostname,
            "port": POSTGRESQL_PORT,
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

                    // delete replication slot, the slot can be still held by a stale walsender
                    for ( let attempt = 0; attempt < SLOT_DROP_ATTEMPTS; attempt++ ) {
                        res = await dbh.selectRow( sql`SELECT pg_drop_replication_slot( ? )`, [ this.slotId ] );

                        if ( res.ok || signal?.aborted ) break;

                        await sleep( SLOT_DROP_INTERVAL );
                    }

                    if ( !res.ok ) return res;
                }
            }

            // replication slot does not exist
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

    async #stopClusterAfterFailure () {
        const res = await this.#stopClusterFast();

        if ( !res.ok ) {
            await this.#stopClusterImmediate();
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

        // the stop is expected, postgres process must not be treated as crashed
        this.#stopMonitor();

        return this.#spawnPgCtl( "stop", {
            mode,
        } );
    }

    // postgres is daemonized by pg_ctl, so there is no process handle, the postmaster pid is taken from the pid file
    async #startMonitor () {
        this.#stopMonitor();

        const pid = await this.#readPostmasterPid();

        if ( !pid || !this.#isProcessAlive( pid ) ) {
            this.#onPostmasterExit();

            return;
        }

        this.#monitorTimer = setInterval( () => {
            if ( this.#isProcessAlive( pid ) ) return;

            this.#onPostmasterExit();
        }, MONITOR_INTERVAL );

        this.#monitorTimer.unref();
    }

    #stopMonitor () {
        clearInterval( this.#monitorTimer );

        this.#monitorTimer = null;
    }

    async #readPostmasterPid () {
        try {
            const pid = Number.parseInt( await fs.promises.readFile( path.join( this.#dataDir, POSTMASTER_PID_FILE ), "utf8" ), 10 );

            return Number.isInteger( pid ) && pid > 0
                ? pid
                : null;
        }
        catch {
            return null;
        }
    }

    #isProcessAlive ( pid ) {
        try {
            process.kill( pid, 0 );

            return true;
        }
        catch ( e ) {

            // the process exists, but belongs to another user
            return e.code === "EPERM";
        }
    }

    #onPostmasterExit () {
        this.#stopMonitor();

        console.error( "PostgreSQL process is not running, exiting" );

        process.exit( 1 );
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
                    `--pwfile=${ passwordFile.path }`,
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

            const res = await this.#waitProcess( proc );

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

    async #writeHbaConfig () {
        const config = [];

        // generate pg_hba.conf
        for ( const access of this.config.access ) {
            const line = [];

            for ( const name of [ "host", "database", "user", "address", "auth-method", "auth-options" ] ) {
                if ( !access[ name ] ) continue;

                line.push( access[ name ] );
            }

            config.push( line.join( " " ) );
        }

        await utils.writeFile( path.join( this.dataDir, "pg_hba.conf" ), config.join( "\n" ) + "\n" );
    }

    async #writeUserConfig () {
        await this.#initConfigDir();

        // generate user config
        return utils.writeConfig( this.#userConfigPath, this.config.settings );
    }

    async #writeReplicationConfig ( role, { replicationHostname } = {} ) {
        await this.#initConfigDir();

        await this.#deleteReplicationConfig( {
            "keepStandbySignal": true,
        } );

        let config;

        // primary
        if ( role === PRIMARY_NAME ) {
            config = {
                "wal_level": "replica",
                "wal_log_hints": "on",
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

        // synchronous standby
        else if ( role === SYNCHRONOUS_NAME ) {
            config = {
                "primary_conninfo": this.#getPrimaryConninfo( replicationHostname, {
                    "applicationName": SYNCHRONOUS_NAME,
                } ),
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
                "wal_log_hints": "on",
            };
        }

        // asynchronous standby
        else if ( role === ASYNCHRONOUS_NAME ) {
            config = {
                "primary_conninfo": this.#getPrimaryConninfo( replicationHostname, {
                    "applicationName": ASYNCHRONOUS_NAME,
                } ),
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
                "wal_log_hints": "on",
            };
        }

        await utils.writeConfig( this.#replicationConfigPath, config );

        // standby.signal is required for standby roles, otherwise the server will be started as a primary
        if ( role !== PRIMARY_NAME ) {
            await this.#writeStandbySignal();
        }
    }

    #getPrimaryConninfo ( replicationHostname, { applicationName } = {} ) {
        return utils.buildConninfo( {
            "host": replicationHostname,
            "port": POSTGRESQL_PORT,
            "user": this.config.replication.username,
            "password": this.config.replication.password,
            "dbname": "postgres",
            "application_name": applicationName,
        } );
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

        // remove standby.signal
        if ( !keepStandbySignal ) {
            await this.#deleteStandbySignal();
        }

        // remove replication auto config
        if ( await pathExists( this.#autoConfigPath ) ) {
            const config = ( await fs.promises.readFile( this.#autoConfigPath, "utf8" ) )
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

    async #deleteStandbySignal () {
        return fs.promises.rm( this.#standbySignalPath, { "force": true } );
    }

    async #deleteRecoverySignal () {
        return fs.promises.rm( this.#recoverySignalPath, { "force": true } );
    }

    async #spawnPgCtl ( command, { wait = true, timeout = 86_400, mode, options, stdio = DEFAULT_STDIO, signal } = {} ) {
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
            signal,
        } );

        return this.#waitProcess( proc );
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

    async #waitProcess ( proc ) {
        return new Promise( resolve => {
            let stderr = "";

            // collect the tail of stderr, if it is piped
            if ( proc.stderr ) {
                proc.stderr.setEncoding( "utf8" );

                proc.stderr.on( "data", data => {
                    stderr = ( stderr + data ).slice( -STDERR_MAX_LENGTH );
                } );
            }

            proc.once( "error", e => resolve( result( [ 500, e.message ] ) ) );

            proc.once( "close", code => resolve( code === 0
                ? result( 200 )
                : result( [ 500, stderr.trim() || `Process exited with code ${ code }` ] ) ) );
        } );
    }

    #spawnSync ( command, args, { cwd, stdio = DEFAULT_STDIO, env, uid = true } = {} ) {
        const options = {
            cwd,
            stdio,
            env,
        };

        if ( uid ) {
            options.uid = utils.uid;
            options.gid = utils.gid;
        }

        const res = childProcess.spawnSync( command, args, options );

        if ( res.error || res.status !== 0 ) {
            return result( 500 );
        }
        else {
            return result( 200 );
        }
    }
}
