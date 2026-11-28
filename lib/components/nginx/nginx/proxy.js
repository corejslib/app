import fs from "node:fs";
import path from "node:path";
import ejs from "#core/ejs";
import NginxProxyServerNames from "./proxy/server-names.js";
import NginxProxyServers from "./proxy/servers.js";
import NginxProxyUpstreams from "./proxy/upstreams.js";

const httpConfigTemplate = await ejs.fromFile( new URL( "../resources/upstream.http.nginx.conf", import.meta.url ) ),
    streamConfigTemplate = await ejs.fromFile( new URL( "../resources/upstream.stream.nginx.conf", import.meta.url ) );

export default class NginxProxy {
    #nginx;
    #id;
    #upstreamPort;
    #upstreamProxyProtocol;
    #serverNames;
    #servers;
    #upstreams;
    #httpConfigPath;
    #streamConfigPath;
    #isDeleted = false;

    constructor ( nginx, id, { upstreamPort, upstreamProxyProtocol, serverNames, servers, upstreams } = {} ) {
        this.#nginx = nginx;
        this.#id = id;
        this.#upstreamPort = this.#nginx.validateIpPort( upstreamPort );
        this.#upstreamProxyProtocol = upstreamProxyProtocol === "v1" || upstreamProxyProtocol === "v2"
            ? upstreamProxyProtocol
            : false;

        this.#httpConfigPath = this.nginx.configsDir + `/http-upstreams/${ this.#id }.nginx.conf`;
        this.#streamConfigPath = this.nginx.configsDir + `/stream-upstreams/${ this.#id }.nginx.conf`;

        // add server names
        this.#serverNames = new NginxProxyServerNames( this.#nginx, serverNames );

        // add servers
        this.#servers = new NginxProxyServers( this, servers );

        // add upstreams
        this.#upstreams = new NginxProxyUpstreams( this, upstreams );
    }

    // properties
    get nginx () {
        return this.#nginx;
    }

    get id () {
        return this.#id;
    }

    get upstreamPort () {
        return this.#upstreamPort;
    }

    get upstreamProxyProtocol () {
        return this.#upstreamProxyProtocol;
    }

    get serverNames () {
        return this.#serverNames;
    }

    get servers () {
        return this.#servers;
    }

    get upstreams () {
        return this.#upstreams;
    }

    // public
    delete () {
        if ( this.#isDeleted ) return;

        this.#isDeleted = true;

        // delete servers
        for ( const server of this.#servers ) {
            server.delete();
        }

        this.nginx.proxies.delete( this.#id );
    }

    writeConfig ( { hasHttpServers, hasStreamServers } = {} ) {
        if ( hasHttpServers ) {
            this.#writeConfigFile( httpConfigTemplate, this.#httpConfigPath );
        }

        if ( hasStreamServers ) {
            this.#writeConfigFile( streamConfigTemplate, this.#streamConfigPath );
        }
    }

    // private
    #writeConfigFile ( template, configPath ) {
        const config = template.renderSync( {
            "proxy": this,
        } );

        fs.mkdirSync( path.dirname( configPath ), { "recursive": true } );
        fs.writeFileSync( configPath, config );
    }
}
