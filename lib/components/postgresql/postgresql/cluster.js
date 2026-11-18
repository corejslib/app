import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import RandomValues from "#core/crypto/random-values";
import { pathExists } from "#core/fs";
import sql from "#core/sql";
import LifecycleManager from "#core/threads/lifecycle-manager";
import { TmpDir, TmpFile } from "#core/tmp";
import { sleep } from "#core/utils";
import utils, { ROLE } from "./utils.js";

const DEFAULT_STDIO = "ignore", // "inherit",
    REPLAY_POLL_INTERVAL = 1000,
    REPLAY_STABLE_CHECKS = 3,
    REPLAY_STALL_TIMEOUT = 600_000,
    REPLICATION_CHECK_INTERVAL = 10_000,
    REPLICATION_STALL_TIMEOUT = 300_000,
    POSTGRESQL_PORT = 5432,
    LISTEN_ADDRESSES = "0.0.0.0",
    START_POLL_INTERVAL = 500,
    SLOT_DROP_ATTEMPTS = 10,
    SLOT_DROP_INTERVAL = 1000,
    STDERR_MAX_LENGTH = 4096,
    STDERR_STDIO = [ "ignore", DEFAULT_STDIO, "pipe" ];

export default class PostgresqlCluster {
    #postgresql;
    #app;
    #version;
    #name;
    #binDir;
    #clusterDir;
    #dataDir;
    #configPath;
    // eslint-disable-next-line no-unused-private-class-members
    #autoConfigPath;
    #standbySignalPath;
    #defaultConfigPath;
    #userConfigPath;
    #replicationConfigPath;
    #recoverySignalPath;
    // eslint-disable-next-line no-unused-private-class-members
    #recoveryConfigPath;
    #backupLabelPath;
    #rewindMarkerPath;
    #recoveryMarkerPath;
    #postgres;
    #replicationMonitor = null;
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
        this.#backupLabelPath = path.join( this.#dataDir, "backup_label" );
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
        this.#slotId ??= this.#postgresql.app.env.instanceId.replaceAll( "-", "" );

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

        this.#lifecycleManager.beginThread();

        this.#busy = true;
        this.#status = "recovering";

        const res = await this.#recoverCluster();

        if ( res.ok ) {
            this.#log( `Cluster recovered, timeline: ${ res.data.timeline }, lsn: ${ res.data.lsn || "-" }` );
        }
        else {
            this.#log( `Unable to recover cluster: ${ res.statusText }` );
        }

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

        this.#lifecycleManager.endThread();

        return res;
    }

    async startCluster ( role, { replicationHostname } ) {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        if ( this.#busy ) return result( [ 500, "Cluster is busy" ] );

        if ( this.#status !== "stopped" ) return result( [ 500, "Cluster is started" ] );

        this.#lifecycleManager.beginThread();

        this.#busy = true;
        this.#status = "starting";

        let res;

        if ( role === ROLE.PRIMARY ) {
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

            // from now on the exit of the postgres process is fatal
            this.#watchPostgres();

            // from now on the standby, that does not receive wal, is fatal
            if ( role !== ROLE.PRIMARY ) this.#startReplicationMonitor();

            // register service-discovery
            this.app.cluster.serviceDiscovery.addService( `postgresql-${ this.#role }`, POSTGRESQL_PORT );

            // register nginx upstream proxy
            this.#registerNginx( this.#role );

            this.#log( `Service postgresql-${ this.#role } registered` );

            this.#log( `Cluster started as ${ role }` );
        }
        else {
            this.#status = "stopped";
            this.#role = null;

            this.#log( `Unable to start cluster as ${ role }: ${ res.statusText }` );
        }

        const status = await this.getStatus();
        res.data = status.data;

        this.#lifecycleManager.endThread();

        return res;
    }

    async stopCluster () {
        if ( !this.#lifecycleManager.canBeginActivity ) return result( [ 500, "PostgreSQL component is not statred" ] );

        if ( this.#busy ) return result( [ 500, "Cluster is busy" ] );

        this.#lifecycleManager.beginThread();

        this.#busy = true;
        this.#status = "stopping";

        const res = await this.#stopClusterFast();

        if ( res.ok ) {
            this.#log( "Cluster stopped" );
        }
        else {
            this.#log( `Unable to stop cluster: ${ res.statusText }` );
        }

        // unregister service-discovery
        this.app.cluster.serviceDiscovery.addService( `postgresql-${ this.#role }`, POSTGRESQL_PORT );

        // unregister nginx upstream proxy
        this.#registerNginx( this.#role, { "deleteProxy": true } );

        this.#busy = false;
        this.#status = "stopped";
        this.#role = null;
        this.#timeline = null;
        this.#lsn = null;
        this.#history = null;

        const status = await this.getStatus();
        res.data = status.data;

        this.#lifecycleManager.endThread();

        return res;
    }

    // private
    #log ( message ) {
        console.log( `[postgresql] ${ message }` );
    }

    // logs the result of the operation and returns it as is
    #logResult ( operation, res ) {
        if ( res.ok ) {
            this.#log( `${ operation }: ok` );
        }
        else {
            this.#log( `${ operation }: failed, ${ res.statusText }` );
        }

        return res;
    }

    async #start ( signal ) {

        // standby.signal, created by the interrupted recovery, must not turn the primary into a standby
        await this.#discardTemporaryStandbySignal();

        return result( 200 );
    }

    async #stop ( signal ) {

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
            this.#log( "Cluster is not initialized, there is nothing to recover" );

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
            res = await this.#startPostgres( {
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
            await this.#writeReplicationConfig( ROLE.PRIMARY );

            // server can stay running after an error or abort
            needStop = true;

            // start server
            res = await this.#startPostgres( { signal } );
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
        if ( role !== ROLE.STANDBY_SYNCHRONOUS && role !== ROLE.STANDBY_ASYNCHRONOUS ) return result( [ 400, `Invalid standby role: ${ role }` ] );

        let res, needStop;

        try {
            await this.#discardBrokenDataDir();
            await this.#discardTemporaryStandbySignal();

            // rewind
            if ( await this.#hasDataDir() ) {

                // create replication slot, a slot, that is lost or invalidated, is recreated
                res = await this.#checkReplicationSlot( replicationHostname, { signal } );
                if ( !res.ok ) return res;

                res = await this.#rewindDataDir( replicationHostname, { signal } );

                // rewind failed
                if ( !res.ok ) {
                    if ( signal?.aborted ) return res;

                    this.#log( "Rewind failed, falling back to base backup" );

                    res = await this.#makeBaseBackup( replicationHostname, { signal } );
                    if ( !res.ok ) return res;
                }

                // rewind succeeded
                else {

                    // the slot protects only the wal since the moment of its creation, the wal, that the standby needs, can be already removed from the primary,
                    // in this case the standby never becomes consistent and the start would wait forever
                    res = await this.#checkRequiredWal( replicationHostname );
                    if ( !res.ok ) return res;

                    if ( !res.data.available ) {
                        this.#log( "WAL required by the standby is not available on the primary, falling back to base backup" );

                        res = await this.#makeBaseBackup( replicationHostname, { signal } );
                        if ( !res.ok ) return res;
                    }
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
            res = await this.#startPostgres( { signal } );
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

                        this.#log( `Local WAL replay finished, lsn: ${ lsn }` );

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
            const res = await dbh.exec( sql`
-- the role is required by standbys to connect, so the commit must not wait for synchronous standbys, which are not connected yet
SET synchronous_commit = local;

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

            return this.#logResult( "Replication role updated", res );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    async #checkpoint () {
        const dbh = sql.new( "postgresql:" );

        try {

            // CHECKPOINT can not be executed inside of a transaction block, so it must be a separate query
            const res = await dbh.exec( sql`CHECKPOINT` );

            return this.#logResult( "Checkpoint", res );
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

        const res = this.#logResult( "pg_rewind", await this.#waitProcess( proc ) );
        if ( !res.ok ) return res;

        // pg_rewind copies configs from the source, remove replication settings of the source
        await this.#deleteReplicationConfig();

        // pg_rewind does not touch pg_replslot, slots of the former primary are meaningless for a standby and keep wal on it
        await this.#deleteLocalReplicationSlots();

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

            res = this.#logResult( "pg_basebackup", await this.#waitProcess( proc ) );

            if ( !res.ok ) {

                // the slot, created by pg_basebackup, can stay after a failure and keep wal on the primary, if the abort is requested, the slot is dropped by the next start
                if ( !signal?.aborted ) {
                    await this.#checkReplicationSlot( replicationHostname, { "deleteSlot": true } );
                }

                return res;
            }

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

                this.#log( "Current data dir moved to backup" );

                restore = true;
            }

            // move base backup to data dir
            await fs.promises.rename( newDataDirPath, this.dataDir );

            this.#log( "New data dir moved in place" );
        }
        catch ( e ) {

            // restore data dir backup
            if ( restore ) {
                try {
                    await fs.promises.rename( dataDirBackup.path, this.dataDir );

                    this.#log( "Data dir backup restored" );
                }
                catch ( e_ ) {
                    return result( [ 500, `${ e.message }. Unable to restore data dir backup: ${ e_.message }` ] );
                }
            }

            this.#log( `Unable to replace data dir: ${ e.message }` );

            return result( [ 500, e.message ] );
        }

        // new data dir is in place, the marker is obsolete
        await fs.promises.rm( this.#rewindMarkerPath, { "force": true } );

        // remove data dir backup, failure is not critical
        if ( dataDirBackup ) {
            try {
                await dataDirBackup.destroy();
            }
            catch ( e ) {
                this.#log( `Unable to remove data dir backup: ${ e.message }` );
            }
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

        this.#log( "Broken data dir discarded" );
    }

    #createReplicationDbh ( replicationHostname ) {
        return sql.new( "postgresql:", {
            "username": this.config.replication.username,
            "password": this.config.replication.password,
            "hostname": replicationHostname,
            "port": POSTGRESQL_PORT,
            "database": "postgres",
        } );
    }

    // replication slots are not replicated, so a new primary has no slot of the standby after the failover
    // a valid slot is kept, because it protects wal since its restart_lsn, a lost or invalidated slot is useless and is recreated
    async #checkReplicationSlot ( replicationHostname, { deleteSlot, signal } = {} ) {
        let res;

        const dbh = this.#createReplicationDbh( replicationHostname );

        try {

            // get replication slot
            res = await dbh.selectRow( sql`SELECT * FROM pg_replication_slots WHERE slot_name = ?`, [ this.slotId ] );
            if ( !res.ok ) return res;

            const slot = res.data;

            this.#log( `Replication slot ${ this.slotId } on ${ replicationHostname }: ${ slot
                ? "exists"
                : "not found" }` );

            // delete replication slot
            if ( deleteSlot ) {
                if ( slot ) {
                    res = await this.#dropReplicationSlot( dbh, { signal } );
                    if ( !res.ok ) return res;
                }

                return result( 200 );
            }

            // replication slot exists
            if ( slot ) {
                const invalidReason = this.#getInvalidSlotReason( slot );

                // the slot is valid
                if ( !invalidReason ) return result( 200 );

                this.#log( `Replication slot ${ this.slotId } is not usable (${ invalidReason }), recreating` );

                res = await this.#dropReplicationSlot( dbh, { signal } );
                if ( !res.ok ) return res;
            }

            // create replication slot
            res = await dbh.selectRow( sql`SELECT pg_create_physical_replication_slot( ?, true )`, [ this.slotId ] );
            if ( !res.ok ) return res;

            this.#log( `Replication slot ${ this.slotId } created` );

            return result( 200 );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    // returns the reason, why the slot can not be used, or null, if the slot is valid
    #getInvalidSlotReason ( slot ) {

        // PostgreSQL 17+, for example "idle_timeout" (idle_replication_slot_timeout, PostgreSQL 18+) or "wal_removed"
        if ( slot.invalidation_reason ) return slot.invalidation_reason;

        // PostgreSQL 13+, the wal required by the slot is removed
        if ( slot.wal_status === "lost" ) return "wal_removed";

        // the slot does not reserve wal
        if ( !slot.restart_lsn ) return "restart_lsn is not set";

        return null;
    }

    // the slot can be still held by a stale walsender, so the drop is repeated
    async #dropReplicationSlot ( dbh, { signal } = {} ) {
        let res;

        for ( let attempt = 0; attempt < SLOT_DROP_ATTEMPTS; attempt++ ) {
            res = await dbh.selectRow( sql`SELECT pg_drop_replication_slot( ? )`, [ this.slotId ] );

            if ( res.ok || signal?.aborted ) break;

            this.#log( `Unable to drop replication slot ${ this.slotId } (attempt ${ attempt + 1 } of ${ SLOT_DROP_ATTEMPTS }): ${ res.statusText }` );

            await sleep( SLOT_DROP_INTERVAL );
        }

        if ( res.ok ) this.#log( `Replication slot ${ this.slotId } dropped` );

        return res;
    }

    // removes slots from the data dir of the stopped cluster, failure is not critical, the slots only keep wal
    async #deleteLocalReplicationSlots () {
        const slotsDir = path.join( this.#dataDir, "pg_replslot" );

        try {
            const entries = await fs.promises.readdir( slotsDir );

            for ( const entry of entries ) {
                await fs.promises.rm( path.join( slotsDir, entry ), {
                    "recursive": true,
                    "force": true,
                } );
            }

            if ( entries.length ) this.#log( `Local replication slots deleted: ${ entries.length }` );
        }
        catch ( e ) {
            if ( e.code === "ENOENT" ) return;

            this.#log( `Unable to delete local replication slots: ${ e.message }` );
        }
    }

    // checks, that the primary still has the wal, from which the standby has to continue
    // the oldest wal segment of the primary is compared with the required one ignoring the timeline (the first 8 chars of the file name), the primary removes the wal from the oldest
    async #checkRequiredWal ( replicationHostname ) {
        let res;

        res = await this.#getRequiredWalSuffix();
        if ( !res.ok ) return res;

        const requiredSuffix = res.data;

        // the required position is unknown, the check is impossible
        if ( !requiredSuffix ) {
            this.#log( "Required WAL position is unknown, availability of WAL on the primary is not checked" );

            return result( 200, { "available": true } );
        }

        const dbh = this.#createReplicationDbh( replicationHostname );

        try {

            // pg_ls_dir is granted to the replication role for pg_rewind
            res = await dbh.selectRow( sql`
SELECT min( substr( t.name, 9 ) ) AS oldest
FROM pg_catalog.pg_ls_dir( 'pg_wal', false, false ) AS t ( name )
WHERE t.name ~ '^[0-9A-F]{24}$'
` );
            if ( !res.ok ) return res;

            const oldestSuffix = res.data?.oldest;

            if ( !oldestSuffix ) return result( [ 500, "Unable to get the oldest WAL segment of the primary" ] );

            const available = oldestSuffix <= requiredSuffix;

            this.#log( `Required WAL segment ${ requiredSuffix }, the oldest on the primary ${ oldestSuffix }: ${ available
                ? "available"
                : "removed" }` );

            return result( 200, { available } );
        }
        finally {
            await dbh.forceDestroy();
        }
    }

    // returns the wal segment (log + segment, 16 hex chars without the timeline), from which the stopped standby has to receive wal, or null, if it is unknown
    async #getRequiredWalSuffix () {
        let label;

        // pg_rewind writes backup_label, if the rewind was required, the recovery starts from the checkpoint before the divergence point
        try {
            label = await fs.promises.readFile( this.#backupLabelPath, "utf8" );
        }
        catch ( e ) {
            if ( e.code !== "ENOENT" ) return result( [ 500, e.message ] );
        }

        if ( label != null ) {
            const match = label.match( /^START WAL LOCATION: \S+ \(file ([\dA-F]{24})\)$/mv );

            if ( !match ) return result( [ 500, "Unable to parse backup_label" ] );

            return result( 200, match[ 1 ].slice( 8 ) );
        }

        // the rewind was not required, the standby continues from the end of its local wal, known from the last recovery
        if ( !this.#lsn ) return result( 200, null );

        const res = await this.#getControlData();
        if ( !res.ok ) return res;

        const segmentSize = BigInt( res.data[ "Bytes per WAL segment" ] ),
            [ high, low ] = this.#lsn.split( "/", 2 ),
            segmentNumber = ( ( BigInt( `0x${ high }` ) << 32n ) | BigInt( `0x${ low }` ) ) / segmentSize,
            segmentsPerLog = 0x1_0000_0000n / segmentSize;

        return result( 200, [ segmentNumber / segmentsPerLog, segmentNumber % segmentsPerLog ].map( value => value.toString( 16 ).toUpperCase().padStart( 8, "0" ) ).join( "" ) );
    }

    async #stopClusterAfterFailure () {
        const res = await this.#stopClusterFast();

        if ( !res.ok ) {
            this.#log( "Fast stop after failure failed, stopping immediately" );

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

        // the stop is expected, the standby must not be treated as broken
        await this.#stopReplicationMonitor();

        const postgres = this.#postgres;

        // the stop is expected, postgres process must not be treated as crashed
        if ( postgres ) postgres.expectedExit = true;

        const res = await this.#spawnPgCtl( "stop", {
            mode,
        } );

        if ( postgres ) {
            if ( res.ok ) {

                // wait until the process is closed, so the next start does not overlap with it
                await postgres.exited;
            }
            else if ( !postgres.closed ) {

                // stop failed, the server is still running
                postgres.expectedExit = false;
            }
        }

        return res;
    }

    // postgres is started in the foreground by this process, so its exit is reported by the "close" event instead of polling of the pid file
    async #startPostgres ( { options, signal } = {} ) {
        const args = [ "-D", this.#dataDir ];

        if ( options != null ) {
            for ( const [ key, value ] of Object.entries( options ) ) {
                args.push( "-c", `${ key }=${ value }` );
            }
        }

        const postgres = this.#spawnPostgres( args ),
            res = await this.#waitPostgresReady( postgres, { signal } );

        return this.#logResult( `postgres start (pid: ${ postgres.proc.pid })`, res );
    }

    #spawnPostgres ( args ) {

        // detached: postgres must not receive the signals of the controlling terminal (for example Ctrl+C), it is stopped by the cluster stop
        const proc = this.#spawn( `${ this.binDir }/postgres`, args, {
                "detached": true,
            } ),
            exited = Promise.withResolvers(),
            postgres = {
                proc,
                "exited": exited.promise,
                "resolveExited": exited.resolve,
                "closed": false,
                "exitMessage": null,
                "expectedExit": false,
                "critical": false,
            };

        proc.on( "error", e => this.#onPostgresClose( postgres, e.message ) );

        proc.on( "close", ( code, signal ) => this.#onPostgresClose( postgres, signal
            ? `terminated by signal ${ signal }`
            : `exited with code ${ code }` ) );

        this.#postgres = postgres;

        return postgres;
    }

    // postgres does not accept connections until the startup (including the crash recovery) is finished, the same as "pg_ctl start --wait"
    async #waitPostgresReady ( postgres, { signal } = {} ) {
        while ( true ) {
            if ( signal?.aborted ) return result( [ 500, "Aborted" ] );

            const res = await this.#spawnPgIsReady();

            // the process was closed, so the server, that accepts connections, is a foreign one
            if ( postgres.closed ) return result( [ 500, `PostgreSQL process ${ postgres.exitMessage }` ] );

            if ( res.ok ) return result( 200 );

            await Promise.race( [ sleep( START_POLL_INTERVAL ), postgres.exited ] );
        }
    }

    async #spawnPgIsReady () {
        const proc = this.#spawn( `${ this.binDir }/pg_isready`, [ `--port=${ POSTGRESQL_PORT }`, "--quiet" ] );

        return this.#waitProcess( proc );
    }

    #onPostgresClose ( postgres, message ) {
        if ( postgres.closed ) return;

        postgres.closed = true;
        postgres.exitMessage = message;

        if ( this.#postgres === postgres ) this.#postgres = null;

        postgres.resolveExited();

        // postgres process is crashed or killed
        if ( postgres.critical && !postgres.expectedExit ) this.#onPostgresExit( message );
    }

    #watchPostgres () {
        const postgres = this.#postgres;

        // the process has already exited
        if ( !postgres ) {
            this.#onPostgresExit( "process is not found" );

            return;
        }

        postgres.critical = true;
    }

    // postgres does not exit, if the standby can not receive wal (for example, the replication slot is lost): the walreceiver is restarted endlessly and the standby stays alive with stale data,
    // so the process is exited and the cluster manager restarts the node, on the start the slot is checked and recreated, and the base backup is made if the wal is already removed
    #startReplicationMonitor () {
        const monitor = {

            // the connection is persistent, it is used by all checks and is destroyed when the monitor is stopped
            "dbh": sql.new( "postgresql:" ),
            "stopped": false,
            "timer": null,
            "wake": null,
            "done": null,
        };

        this.#replicationMonitor = monitor;

        monitor.done = this.#runReplicationMonitor( monitor );
    }

    // the connection is destroyed before the server is stopped, so it does not hold the stop
    async #stopReplicationMonitor () {
        const monitor = this.#replicationMonitor;

        if ( !monitor ) return;

        this.#replicationMonitor = null;

        monitor.stopped = true;

        clearTimeout( monitor.timer );

        monitor.wake?.();

        await monitor.dbh.forceDestroy();

        await monitor.done;
    }

    async #runReplicationMonitor ( monitor ) {
        let brokenSince = null;

        while ( !monitor.stopped ) {
            await new Promise( resolve => {
                monitor.wake = resolve;
                monitor.timer = setTimeout( resolve, REPLICATION_CHECK_INTERVAL );

                monitor.timer.unref();
            } );

            if ( monitor.stopped ) return;

            const state = await this.#getReplicationState( monitor.dbh );

            if ( monitor.stopped ) return;

            // the state is unknown
            if ( !state ) continue;

            // wal is received, or the startup process is still replaying local wal (the walreceiver is started after that)
            if ( state.streaming || !state.startupIdle ) {
                brokenSince = null;

                continue;
            }

            brokenSince ??= Date.now();

            if ( Date.now() - brokenSince >= REPLICATION_STALL_TIMEOUT ) {
                this.#onReplicationBroken( `wal is not received for ${ Math.round( ( Date.now() - brokenSince ) / 1000 ) } seconds` );

                return;
            }
        }
    }

    async #getReplicationState ( dbh ) {
        try {
            const res = await dbh.selectRow( sql`
SELECT
    ( SELECT status FROM pg_catalog.pg_stat_wal_receiver ) AS receiver_status,
    ( SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE backend_type = 'startup' AND wait_event IN ( 'RecoveryWalStream', 'RecoveryRetrieveRetryInterval' ) ) AS startup_idle
` );
            if ( !res.ok || !res.data ) return null;

            return {
                "streaming": res.data.receiver_status === "streaming",
                "startupIdle": res.data.startup_idle > 0,
            };
        }
        catch {
            return null;
        }
    }

    #onReplicationBroken ( message ) {
        console.error( `PostgreSQL standby is broken (${ message }), exiting` );

        process.exit( 1 );
    }

    #onPostgresExit ( message ) {
        console.error( `PostgreSQL process is not running (${ message }), exiting` );

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

            const res = this.#logResult( "initdb", await this.#waitProcess( proc ) );

            if ( res.ok ) {
                await fs.promises.rename( tmpDir.path, this.dataDir );

                this.#log( "Data dir initialized" );
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

        let unixSocketDirectories = [ this.postgresql.unixSocketDir ];
        if ( this.config[ role ].publishUnixSocket ) {
            unixSocketDirectories.push( this.postgresql.publicUnixSocketDir );
        }
        unixSocketDirectories = unixSocketDirectories.join( ", " );

        // primary
        if ( role === ROLE.PRIMARY ) {
            config = {
                "unix_socket_directories": unixSocketDirectories,
                "listen_addresses": LISTEN_ADDRESSES,
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
                config.synchronous_standby_names = `${ numberOfSynchronousStandbys } ( "${ ROLE.STANDBY_SYNCHRONOUS }" )`;
            }
        }

        // synchronous standby
        else if ( role === ROLE.STANDBY_SYNCHRONOUS ) {
            config = {
                "unix_socket_directories": unixSocketDirectories,
                "listen_addresses": LISTEN_ADDRESSES,
                "primary_conninfo": this.#getPrimaryConninfo( replicationHostname, {
                    "applicationName": ROLE.STANDBY_SYNCHRONOUS,
                } ),
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
                "wal_log_hints": "on",
            };
        }

        // asynchronous standby
        else if ( role === ROLE.STANDBY_ASYNCHRONOUS ) {
            config = {
                "unix_socket_directories": unixSocketDirectories,
                "listen_addresses": LISTEN_ADDRESSES,
                "primary_conninfo": this.#getPrimaryConninfo( replicationHostname, {
                    "applicationName": ROLE.STANDBY_ASYNCHRONOUS,
                } ),
                "primary_slot_name": this.slotId,
                "recovery_target_timeline": "latest",
                "hot_standby": true,
                "wal_log_hints": "on",
            };
        }

        await utils.writeConfig( this.#replicationConfigPath, config );

        // standby.signal is required for standby roles, otherwise the server will be started as a primary
        if ( role !== ROLE.PRIMARY ) {
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
        // if ( await pathExists( this.#autoConfigPath ) ) {
        //     const config = ( await fs.promises.readFile( this.#autoConfigPath, "utf8" ) )
        //         .split( "\n" )
        //         .map( line => line.trim() )
        //         .filter( line => {
        //             if ( line.startsWith( "primary_conninfo" ) ) return false;

        //             if ( line.startsWith( "primary_slot_name" ) ) return false;

        //             return true;
        //         } )
        //         .join( "\n" );

        //     await utils.writeFile( this.#autoConfigPath, config );
        // }
    }

    async #deleteStandbySignal () {
        return fs.promises.rm( this.#standbySignalPath, { "force": true } );
    }

    async #deleteRecoverySignal () {
        return fs.promises.rm( this.#recoverySignalPath, { "force": true } );
    }

    #registerNginx ( role, { deleteProxy } = {} ) {
        const serviceName = "postgresql-" + role;

        if ( this.config[ role ].nginx.enabled && this.app.nginxUpstream ) {
            if ( deleteProxy ) {
                this.app.nginxUpstream.deleteProxy( serviceName );
            }
            else {
                const servers = [
                    {
                        "port": this.config[ role ].nginx.port,
                        "type": "tcp",
                        "useSsl": true,
                    },
                ];

                if ( this.config[ role ].nginx.defaultServer ) {
                    servers.push( {
                        "port": this.config[ role ].nginx.port,
                        "type": "tcp",
                        "useSsl": false,
                    } );
                }

                this.app.nginxUpstream.addProxy( serviceName, {
                    "upstreamPort": POSTGRESQL_PORT,
                    "serverNames": this.config[ role ].nginx.serverNames,
                    servers,
                } );
            }
        }
    }

    async #spawnPgCtl ( command, { wait = true, timeout = 86_400, mode, stdio = DEFAULT_STDIO, signal } = {} ) {
        const args = [ command, `--pgdata=${ this.#dataDir }` ];

        if ( wait ) args.push( "--wait" );

        if ( timeout ) args.push( `--timeout=${ timeout }` );

        if ( mode ) args.push( `--mode=${ mode }` );

        const proc = this.#spawn( `${ this.binDir }/pg_ctl`, args, {
            stdio,
            signal,
        } );

        const res = await this.#waitProcess( proc );

        return this.#logResult( `pg_ctl ${ command }${ mode
            ? ` (${ mode })`
            : "" }`, res );
    }

    #spawn ( command, args, { cwd, stdio = DEFAULT_STDIO, env, uid = true, signal, detached } = {} ) {
        const options = {
            cwd,
            stdio,
            env,
            signal,
            detached,
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
            this.#log( `${ command } ${ args[ 0 ] }: failed` );

            return result( 500 );
        }
        else {
            this.#log( `${ command } ${ args[ 0 ] }: ok` );

            return result( 200 );
        }
    }
}
