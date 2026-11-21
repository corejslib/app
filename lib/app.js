import "#core/result";
import "#core/destroy-controller";
import "#core/locale";
import Ajv from "#core/ajv";
import Cli from "#core/cli";
import { readConfig } from "#core/config";
import env from "#core/env";
import Events from "#core/events";
import externalResources from "#core/external-resources";
import Logger from "#core/logger";
import { mergeObjects } from "#core/utils";
import Components from "#lib/components";
import constants from "#lib/constants";
import Templates from "#lib/templates";

new Logger( {
    "colorMode": true,
    "enableLabels": true,
} ).installGlobalConsole();

export default class App {
    #components;
    #isDestroying = false;
    #events = new Events();
    #templates = new Templates( this );

    // static
    static async start () {
        const app = new this();

        const res = await app.#start();

        if ( !res.ok ) {
            process.destroy( {
                "code": 1,
            } );
        }

        return app;
    }

    // properties
    get location () {
        throw "App location getter is not defined";
    }

    get components () {
        return this.#components;
    }

    get templates () {
        return this.#templates;
    }

    get maxListeners () {
        return this.#events.maxListeners;
    }

    set maxListeners ( value ) {
        this.#events.maxListeners = value;
    }

    // public
    userIsRoot ( userId ) {
        return userId === constants.rootUserId;
    }

    emailIsLocal ( email ) {
        return email.endsWith( constants.localEmailTld );
    }

    on ( name, listener ) {
        this.#events.on( name, listener );

        return this;
    }

    once ( name, listener ) {
        this.#events.once( name, listener );

        return this;
    }

    off ( name, listener ) {
        this.#events.off( name, listener );

        return this;
    }

    publish ( name, ...args ) {

        // to local emitter
        this.#events.emit( name, ...args );

        // global events to cluster
        if ( name.startsWith( "/" ) ) {
            this.cluster?.publish( {
                "name": "to-app" + name,
                "data": args,
            } );
        }

        return this;
    }

    publishToApi ( name, ...args ) {
        if ( !this.api && !this.cluster ) return this;

        var users, publisherId, localName, cluster;

        if ( typeof name === "object" ) {
            ( { name, users, "data": args, publisherId } = name );
        }

        if ( name.startsWith( "/" ) ) {
            localName = name.slice( 1 );
            cluster = this.cluster;
        }

        if ( name.endsWith( "/" ) ) {
            users ??= args.shift();
        }

        this.api?.publish( {
            "name": localName ?? name,
            users,
            "data": args,
            publisherId,
        } );

        cluster?.publish( {
            "name": "to-api/" + localName,
            users,
            "data": args,
        } );

        return this;
    }

    publishToRpc ( name, ...args ) {
        if ( !this.rpc && !this.cluster ) return this;

        var publisherId, localName, cluster;

        if ( typeof name === "object" ) {
            ( { name, "data": args, publisherId } = name );
        }

        if ( name.startsWith( "/" ) ) {
            localName = name.slice( 1 );
            cluster = this.cluster;
        }

        this.rpc?.publish( {
            "name": localName ?? name,
            "data": args,
            publisherId,
        } );

        cluster?.publish( {
            "name": "to-rpc/" + localName,
            "data": args,
        } );

        return this;
    }

    // protected
    async _cli ( config ) {
        return result( 200 );
    }

    // private
    async #start () {
        let res;

        // create components
        this.#components = new Components( this.location, { "app": this } );

        // load components config
        res = this.#components.loadConfig();
        if ( !res.ok ) return this.#logError( res );

        // cli
        await this.#cli();

        // set mode from cli
        if ( process.cli.globalOptions.mode ) env.setMode( process.cli.globalOptions.mode );

        // load app env and public config
        const config = env.loadEnv();

        // cli config
        res = await this._cli( config );
        if ( !res.ok ) return this.#logError( res );

        // validatee public config structure
        const appPublicConfigValidate = new Ajv().compile( await readConfig( "#resources/schemas/app-public-config.schema.yaml", { "resolve": import.meta.url } ) );

        if ( !appPublicConfigValidate( config ) ) {
            return this.#logError( result( [ 500, `Application public config is not valid:\n${ appPublicConfigValidate.errors }` ] ) );
        }

        // load components
        res = await this.#components.load( process.cli.globalOptions.service || config.defaultService );
        if ( !res.ok ) return this.#logError( res );

        // create components
        res = await this.#components.create( config );
        if ( !res.ok ) return this.#logError( res );

        // install components
        res = await this.#components.install();
        if ( !res.ok ) return this.#logError( res );

        // init app
        res = await this.#init();
        if ( !res.ok ) return this.#logError( res );

        // configure components
        res = await this.#components.configure();
        if ( !res.ok ) return this.#logError( res );

        // add app templates
        if ( this.#components.config.templates ) {
            this.templates.add( this.#components.config.templates );
        }

        // init components
        res = await this.#components.init();
        if ( !res.ok ) return this.#logError( res );

        // handle process destroy
        process.destroyController.on( "destroy", this.#destroy.bind( this ) );

        // start components
        if ( !this.#isDestroying ) {
            res = await this.#components.start();
            if ( !res.ok ) return this.#logError( res );
        }

        // after app start
        if ( !this.#isDestroying ) {
            res = await this.#components.afterAppStarted();
            if ( !res.ok ) return this.#logError( res );

            console.info( "Application started, pid:", process.pid );
        }

        // start updating external resources
        externalResources.startUpdate();

        return result( 200 );
    }

    async #cli () {
        const cli = mergeObjects( {}, await readConfig( new URL( "cli.yaml", import.meta.url ) ), this.#components.config.cli );

        cli.title ||= env.package.name + " v" + env.package.version;

        if ( !this.#components.config.services ) {
            delete cli?.globalOptions?.service;
        }

        await Cli.parse( cli );
    }

    async #init () {

        // link cluster events
        if ( this.cluster ) {
            this.#events.link( this.cluster, {
                "on": name => {
                    return name.startsWith( "/" )
                        ? "to-app" + name
                        : null;
                },
                "forwarder": ( name, args ) => this.#events.emit( name, ...args ),
            } );
        }

        return result( 200 );
    }

    async #destroy () {
        if ( this.#isDestroying ) return;
        this.#isDestroying = true;

        // destroy components
        await this.#components.destroy();
    }

    #logError ( res ) {
        console.error( res + "" );

        return res;
    }
}
