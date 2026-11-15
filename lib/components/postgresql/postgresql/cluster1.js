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
        } );
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

    async #stop () {}

    #onManagerConnect () {}

    #onManagerDisconnect () {}

    #onClusterUpdate () {}

    async #isClusterExists () {
        return pathExists( path.join( this.dataDir, "PG_VERSION" ) );
    }

    // XXX
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

        const proc = this.#spawn(
            `${ this.binDir }/pg_ctl`,
            [

                //
                "start",
                `--pgdata=${ this.#dataDir }`,
                "--wait",
                "--timeout=86400",
                "-o",
                [

                    //
                    "-c listen_addresses=''",
                    "-c archive_mode=off",
                    "-c archive_command=/bin/true",
                ].join( " " ),
            ],
            {
                "stdio": "inherit",
            }
        );

        res = await new Promise( resolve => proc.once( "close", code => resolve( code
            ? result( 500 )
            : result( 200 ) ) ) );
        if ( !res.ok ) return res;

        const dbh = sql.new( "postgresql:" );

        res = await dbh.selectRow( sql`SELECT timeline_id AS timeline, pg_current_wal_flush_lsn() AS lsn FROM pg_control_checkpoint()` );

        dbh.destroy();

        return res;
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
                "stdio": "inherit",
            }
        );

        const res = await new Promise( resolve => proc.once( "close", code => resolve( code
            ? result( 500 )
            : result( 200 ) ) ) );

        await passwordFile.destroy();

        return res;
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
// | ERROR    |     23:5 | no-unused-private-class-members, '#standbySignalPath' is defined but never |
// |          |          | used.                                                                      |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |     25:5 | no-unused-private-class-members, '#userConfigPath' is defined but never    |
// |          |          | used.                                                                      |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |     26:5 | no-unused-private-class-members, '#replicationConfigPath' is defined but   |
// |          |          | never used.                                                                |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |     27:5 | no-unused-private-class-members, '#recoveryConfigPath' is defined but never|
// |          |          |  used.                                                                     |
// |----------+----------+----------------------------------------------------------------------------|
// | ERROR    |   234:11 | no-unused-private-class-members, '#initConfigDir' is defined but never     |
// |          |          | used.                                                                      |
// +----------+----------+----------------------------------------------------------------------------+
// -----END LINT LOG-----
