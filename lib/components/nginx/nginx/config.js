import fs from "node:fs";
import path from "node:path";
import ejs from "#core/ejs";
import NginxProxyDefaultServer from "./proxy/default-server.js";
import NginxServerName from "./proxy/server-name.js";

const routerConfigTemplate = await ejs.fromFile( new URL( "../resources/server.stream-router.nginx.conf", import.meta.url ) );

export default class NginxConfig {
    #nginx;
    #useLocalSocket;
    #localAddress;
    #localAddressPort = 0;
    #nextLocalAddressPort = 0;

    constructor ( nginx ) {
        this.#nginx = nginx;

        if ( this.#nginx.config.localAddress === "unix:" ) {
            this.#useLocalSocket = true;
        }
        else {
            this.#useLocalSocket = false;

            const url = new URL( "tcp://" + this.#nginx.config.localAddress );

            this.#localAddress = url.hostname;
            this.#localAddressPort = +url.port;
        }
    }

    // static
    static #getGroupId ( port, type, useTls, alpnProtocol ) {
        return `${ port }/${ type }/${ useTls }` + ( alpnProtocol
            ? `/${ alpnProtocol }`
            : "" );
    }

    static #createGroup ( { port, type, useProxyProtocol, useTls, alpnProtocol } ) {
        return {
            "id": NginxConfig.#getGroupId( port, type, useTls, alpnProtocol ),
            port,
            type,
            useProxyProtocol,
            useTls,
            "alpnProtocol": alpnProtocol || null,
            "serverNames": new Map(),
            "localAddress": null,
        };
    }

    // groups without alpn go first, alpn groups are sorted by protocol
    static #compareGroups ( a, b ) {
        if ( a.alpnProtocol === b.alpnProtocol ) return 0;

        if ( !a.alpnProtocol ) return -1;

        if ( !b.alpnProtocol ) return 1;

        return a.alpnProtocol < b.alpnProtocol
            ? -1
            : 1;
    }

    static #escapeRegExp ( value ) {
        return value.replaceAll( /[\\^$.*+?\(\)\[\]\{\}\|]/gv, "\\$&" );
    }

    // properties
    get app () {
        return this.#nginx.app;
    }

    get nginx () {
        return this.#nginx;
    }

    // public
    async generate () {
        let servers = [];

        // reset local addresses counter, so repeated generations produce the same addresses
        this.#nextLocalAddressPort = this.#localAddressPort;

        // get servers
        for ( const proxy of this.nginx.proxies ) {

            // proxy has no upstreams
            if ( !proxy.upstreams.hasUpstreams ) continue;

            servers.push( ...proxy.servers );
        }

        const conflicts = {
            "useProxyProtocol": {},
            "udp": {},
        };

        if ( this.app.acme?.httpEnabled ) {
            conflicts.useProxyProtocol[ "80" ] = false;
        }

        // check conflicts
        servers = servers.sort( NginxProxyDefaultServer.compare ).filter( server => {

            // check proxy protocol conflicts
            if ( !server.isUdp ) {
                if ( conflicts.useProxyProtocol[ server.port ] == null ) {
                    conflicts.useProxyProtocol[ server.port ] = server.useProxyProtocol;
                }
                else if ( conflicts.useProxyProtocol[ server.port ] !== server.useProxyProtocol ) {
                    console.warn( `[nginx] conflict on port "${ server.port }". Proxy protocol conflict.` );

                    return false;
                }
            }

            // check udp conflicts
            if ( server.useQuic || server.isUdp ) {
                conflicts.udp[ server.port ] ??= {
                    "quic": 0,
                    "udp": 0,
                };

                const udpConflicts = conflicts.udp[ server.port ];

                if ( server.useQuic ) {
                    if ( udpConflicts.udp ) {
                        console.warn( `[nginx] conflict on port "${ server.port }". UDP port conflict.` );

                        return false;
                    }

                    udpConflicts.quic++;
                }
                else if ( udpConflicts.quic || udpConflicts.udp ) {
                    console.warn( `[nginx] conflict on port "${ server.port }". UDP port conflict.` );

                    return false;
                }
                else {
                    udpConflicts.udp++;
                }
            }

            return true;
        } );

        const groups = {},
            ports = {};

        // add ACME http server
        if ( this.app.acme?.httpEnabled ) {
            const group = NginxConfig.#createGroup( {
                "port": 80,
                "type": "http",
                "useProxyProtocol": false,
                "useTls": false,
            } );

            groups[ group.id ] = group;
        }

        // group servers by port configuration, servers with different alpn protocols are placed in different groups
        for ( const server of servers ) {
            const id = NginxConfig.#getGroupId( server.port, server.type, server.useTls, server.alpnProtocol );

            // init group
            groups[ id ] ??= NginxConfig.#createGroup( server );

            const group = groups[ id ];

            // add server
            if ( server.isDefaultServer ) {

                // group already has default server
                if ( group.serverNames.has( "" ) ) continue;

                group.serverNames.set( "", {
                    "serverName": this.nginx.defaultServerName,
                    server,
                } );
            }
            else {
                for ( const serverName of server.serverNames ) {

                    // group already has server name
                    if ( group.serverNames.has( serverName.name ) ) continue;

                    group.serverNames.set( serverName.name, {
                        serverName,
                        server,
                    } );
                }
            }
        }

        // alpn groups require a group without alpn on the same port, it handles connections without matching alpn
        for ( const group of Object.values( groups ) ) {
            if ( !group.alpnProtocol ) continue;

            const id = NginxConfig.#getGroupId( group.port, group.type, group.useTls );

            groups[ id ] ??= NginxConfig.#createGroup( {
                "port": group.port,
                "type": group.type,
                "useProxyProtocol": group.useProxyProtocol,
                "useTls": group.useTls,
            } );
        }

        // add group default servers for "http" and "tls" groups
        for ( const group of Object.values( groups ) ) {

            // alpn groups do not have default servers, or group already has default server
            if ( group.alpnProtocol || group.serverNames.has( "" ) ) continue;

            if ( group.type === "http" || group.useTls ) {

                // create default server
                group.serverNames.set( "", {
                    "serverName": this.nginx.defaultServerName,
                    "server": new NginxProxyDefaultServer( this.nginx, {
                        "port": group.port,
                        "type": group.type,
                        "useProxyProtocol": group.useProxyProtocol,
                        "useTls": group.useTls,
                    } ),
                    "isGenerated": true,
                } );
            }
        }

        // create ports
        for ( const group of Object.values( groups ) ) {
            const portId = group.port + "/" + ( group.type === "udp"
                ? "udp"
                : "tcp" );

            // init port
            ports[ portId ] ??= {
                "port": group.port,
                "groups": new Set(),
                "defaultNonTlsGroup": null,
                "defaultTlsGroup": null,
                "useProxyProtocol": group.useProxyProtocol,
                "router": null,
            };

            const port = ports[ portId ];

            // "tls" group
            if ( group.useTls ) {
                const defaultServer = group.serverNames.get( "" );

                if ( defaultServer && !group.alpnProtocol ) {
                    const current = port.defaultTlsGroup?.serverNames.get( "" );

                    // explicit default server has priority over generated one
                    if ( !current || ( current.isGenerated && !defaultServer.isGenerated ) ) {
                        port.defaultTlsGroup = group;
                    }
                    else if ( !current.isGenerated && !defaultServer.isGenerated ) {
                        console.warn( `[nginx] conflict on port "${ group.port }". More than one default tls server.` );
                    }
                }
            }

            // non-tls group
            else {

                // port can contain only 1 non-tls servers group
                if ( port.defaultNonTlsGroup ) {
                    console.warn( `[nginx] conflict on port "${ group.port }". Non-tls services can not be mixed on the same port` );

                    continue;
                }
                else {
                    port.defaultNonTlsGroup = group;
                }
            }

            port.groups.add( group );
        }

        // create routers
        for ( const port of Object.values( ports ) ) {

            // use router if port server groups size > 1
            if ( port.groups.size <= 1 ) continue;

            const router = {
                "port": port.port,
                "defaultNonTlsLocalAddress": null,
                "defaultTlsLocalAddress": null,
                "serverNames": new Map(),
                "alpns": [],
                "listen": this.#createRouterListen( port ),
            };

            port.router = router;

            for ( const group of port.groups.values().toArray().sort( NginxConfig.#compareGroups ) ) {
                group.localAddress = this.#createGroupLocalAddress();

                if ( !group.useTls ) continue;

                let alpn;

                // alpn group
                if ( group.alpnProtocol ) {
                    alpn = {
                        "id": router.alpns.length,
                        "protocol": group.alpnProtocol,
                        "regExp": `(?:^|,)${ NginxConfig.#escapeRegExp( group.alpnProtocol ) }(?:,|$)`,
                        "serverNames": new Map(),
                        "defaultLocalAddress": group.serverNames.has( "" )
                            ? group.localAddress
                            : null,
                    };

                    router.alpns.push( alpn );
                }

                for ( const serverName of group.serverNames
                    .values()
                    .map( data => data.serverName )
                    .toArray()
                    .sort( NginxServerName.compare ) ) {

                    // ignore default servers
                    if ( serverName.isDefaultServerName ) continue;

                    // server name + alpn protocol, alpn group is never used as server name only fallback
                    if ( alpn ) {
                        alpn.serverNames.set( serverName.name, group.localAddress );

                        continue;
                    }

                    // server name only
                    if ( router.serverNames.has( serverName.name ) ) continue;

                    router.serverNames.set( serverName.name, group.localAddress );
                }
            }

            router.defaultNonTlsLocalAddress = port.defaultNonTlsGroup?.localAddress;
            router.defaultTlsLocalAddress = port.defaultTlsGroup?.localAddress;
        }

        // proxies are aggregated across all ports
        const proxies = new Map();

        for ( const port of Object.values( ports ) ) {

            // generate servers
            for ( const group of port.groups ) {
                const groupServers = new Map();

                for ( const { serverName, server } of group.serverNames.values() ) {
                    let serverNames = groupServers.get( server );

                    if ( !serverNames ) {
                        serverNames = [];

                        groupServers.set( server, serverNames );
                    }

                    serverNames.push( serverName );
                }

                const entries = groupServers.entries().toArray(),
                    configsPaths = {};

                // Promise.all preserves order, so generated configs are deterministic
                const results = await Promise.all( entries.map( ( [ server, serverNames ] ) => {
                    return server.generateConfig( {
                        serverNames,
                        "localAddress": group.localAddress,
                    } );
                } ) );

                for ( let n = 0; n < entries.length; n++ ) {
                    const configPath = entries[ n ][ 0 ].configPath;

                    configsPaths[ configPath ] ??= [];

                    configsPaths[ configPath ].push( results[ n ] );
                }

                // write configs
                for ( const [ configPath, configs ] of Object.entries( configsPaths ) ) {
                    await fs.promises.mkdir( path.dirname( configPath ), { "recursive": true } );

                    await fs.promises.writeFile( configPath, configs.join( "\n" ) );
                }
            }

            // collect proxies
            for ( const group of port.groups ) {
                for ( const { server } of group.serverNames.values() ) {
                    if ( !server.proxy ) continue;

                    if ( !proxies.has( server.proxy ) ) {
                        proxies.set( server.proxy, {
                            "hasHttpServers": false,
                            "hasStreamServers": false,
                        } );
                    }

                    if ( server.isHttp ) {
                        proxies.get( server.proxy ).hasHttpServers = true;
                    }
                    else {
                        proxies.get( server.proxy ).hasStreamServers = true;
                    }
                }
            }

            // generate routers
            if ( port.router ) {
                const config =
                    (
                        await routerConfigTemplate.render( {
                            "nginx": this.nginx,
                            "router": port.router,
                        } )
                    ).trim() + "\n";

                await fs.promises.mkdir( this.nginx.configsDir + "/stream-servers", { "recursive": true } );

                await fs.promises.writeFile( this.nginx.configsDir + `/stream-servers/${ port.port }-router.nginx.conf`, config );
            }
        }

        // generate upstreams
        await Promise.all( proxies
            .entries()
            .map( ( [ proxy, options ] ) => proxy.writeConfig( options ) )
            .toArray() );
    }

    // private
    #createRouterListen ( port ) {
        const listen = [],
            proxyProtocol = port.useProxyProtocol
                ? "proxy_protocol "
                : "";

        if ( this.nginx.listenIpV4 ) {
            listen.push( `*:${ port.port } default_server ${ proxyProtocol }${ this.#nginx.config.tcpListenOptions }` );
        }

        if ( this.nginx.listenIpV6 ) {
            listen.push( `[::]:${ port.port } default_server ${ proxyProtocol }${ this.#nginx.config.tcpListenOptions }` );
        }

        return listen;
    }

    #createGroupLocalAddress () {
        const port = this.#nextLocalAddressPort++;

        if ( this.#useLocalSocket ) {
            return "unix:" + this.#nginx.app.env.unixSocketsDir + `/nginx-${ port }.socket`;
        }
        else {
            return this.#localAddress + ":" + port;
        }
    }
}
