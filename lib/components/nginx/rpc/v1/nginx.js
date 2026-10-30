export default Super =>
    class extends Super {
        #connections = new Map();
        #proxies = new Map();

        // public
        async [ "API_get-certificates" ] ( ctx, serverNames ) {
            if ( !Array.isArray( serverNames ) ) serverNames = [ serverNames ];

            if ( this.app.nginxUpstream ) {
                return this.app.nginxUpstream.getCertificates( serverNames );
            }
            else {
                const certificates = {};

                await Promise.all( serverNames.map( serverName => {
                    if ( this.app.acme?.canGetCertificate( serverName ) ) {
                        return this.app.acme
                            .getCertificate( serverName, {
                                "pem": true,
                            } )
                            .then( res => {
                                if ( res.ok ) {
                                    certificates[ serverName ] = {
                                        "certificate": res.data.certificate,
                                        "privateKey": res.data.privateKey,
                                        "fingerprint": res.data.fingerprint,
                                        "expires": res.data.expires,
                                    };
                                }
                                else {
                                    certificates[ serverName ] = null;
                                }

                                return res;
                            } );
                    }
                    else {
                        certificates[ serverName ] = null;
                    }
                } ) );

                return result( 200, certificates );
            }
        }

        async [ "API_clear-cache" ] ( ctx ) {
            await this.app.nginx.clearCache();

            return result( 200 );
        }

        async [ "API_update-proxies" ] ( ctx, appName, version, proxies ) {
            const connection = ctx.connection;

            let connectionData = this.#connections.get( connection );

            // register new connection
            if ( !connectionData ) {
                connectionData = {
                    appName,
                    version,
                    "proxies": new Set(),
                };

                this.#connections.set( connection, connectionData );

                connection.once( "disconnect", this.#onDisconnect.bind( this ) );
            }

            // reject if version is older
            else if ( connectionData.version >= version ) {
                return result( 200 );
            }

            connectionData.version = version;

            // index proxies
            if ( proxies ) {
                proxies = new Map( Object.entries( proxies ).map( ( [ serviceName, options ] ) => [
                    "api_" + appName + "_" + serviceName,
                    {
                        options,
                        "hash": JSON.stringify( options ),
                    },
                ] ) );
            }
            else {
                proxies = new Map();
            }

            // add / update proxies
            for ( const [ proxyId, proxyOptions ] of proxies.entries() ) {
                connectionData.proxies.add( proxyId );

                let proxyData = this.#proxies.get( proxyId );

                // proxy already registered
                if ( proxyData ) {
                    if ( version > proxyData.version ) {
                        proxyData.version = version;

                        // proxy configuration updated
                        if ( proxyData.hash !== proxyOptions.hash ) {
                            proxyData.version = version;
                            proxyData.hash = proxyOptions.hash;

                            // re-create proxy
                            proxyData.proxy.delete();

                            this.app.nginx.proxies.add( {
                                [ proxyId ]: proxyOptions,
                            } );

                            proxyData.proxy = this.app.nginx.proxies.get( proxyId );

                            console.log( `[nginx] Proxy updated: ${ proxyId }, config:\n${ JSON.stringify( proxyOptions, null, 4 ) }` );
                        }
                    }
                }

                // proxy not registered
                else {
                    this.app.nginx.proxies.add( {
                        [ proxyId ]: proxyOptions,
                    } );

                    proxyData = {
                        version,
                        "hash": proxyOptions.hash,
                        "proxy": this.app.nginx.proxies.get( proxyId ),
                    };

                    this.#proxies.set( proxyId, proxyData );

                    console.log( `[nginx] Proxy added: ${ proxyId }, config:\n${ JSON.stringify( proxyOptions, null, 4 ) }` );
                }

                console.log( `[nginx] Proxy upstream added: ${ proxyId }, ${ connection.remoteAddress }` );

                // add proxy upstream
                proxyData.proxy.upstreams.add( connection.remoteAddress );
            }

            // check connection for removed proxies
            for ( const proxyId of connectionData.proxies ) {

                // connection proxy was removed
                if ( !proxies.has( proxyId ) ) {

                    // remove proxy from connection
                    connectionData.proxies.delete( proxyId );

                    // delete proxy upstream
                    this.#deleteProxyUpstream( proxyId, connection.remoteAddress );
                }
            }

            return result( 200 );
        }

        // private
        #onDisconnect ( connection ) {
            const connectionData = this.#connections.get( connection );
            this.#connections.delete( connection );

            for ( const proxyId of connectionData.proxies ) {
                this.#deleteProxyUpstream( proxyId, connection.remoteAddress );
            }
        }

        #deleteProxyUpstream ( proxyId, remoteAddress ) {
            const proxyData = this.#proxies.get( proxyId );

            // delete proxy
            if ( proxyData.proxy.upstreams.size === 1 ) {
                proxyData.proxy.delete();

                this.#proxies.delete( proxyId );

                console.log( `[nginx] Proxy deleted: ${ proxyId }` );
            }

            // delete proxy upstream
            else {
                proxyData.proxy.upstreams.delete( remoteAddress );

                console.log( `[nginx] Proxy upstream deleted: ${ proxyId }, ${ remoteAddress }` );
            }
        }
    };
