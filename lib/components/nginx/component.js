import Nginx from "./nginx.js";

export default Super =>
    class extends Super {

        // protected
        async _checkEnabled () {
            return this.isRequired && process.platform === "linux";
        }

        async _install () {
            return new Nginx( this.app, this.config );
        }

        async _start () {
            return this.instance.start();
        }

        async _afterAppStarted () {
            this.instance.proxies.add( {
                "test-1": {
                    "upstreamPort": 90,
                    "serverNames": [ "aaa", "bbb" ],
                    "servers": [
                        {
                            "port": 90,
                            "type": "tcp",
                            "useTls": true,
                        },
                        {
                            "port": 90,
                            "type": "tcp",
                            "useTls": true,
                            "alpnProtocol": "test",
                        },
                        {
                            "port": 90,
                            "type": "tcp",
                            "useTls": false,
                        },
                    ],
                    "upstreams": "127.0.0.1",
                },

                // "test-2": {
                //     "upstreamPort": 90,
                //     "serverNames": "bbb",
                //     "servers": [
                //         {
                //             "port": 90,
                //             "type": "tcp",
                //             "useTls": false,
                //         },
                //     ],
                //     "upstreams": "127.0.0.1",
                // },
            } );

            return result( 200 );
        }

        async _destroy () {
            return this.instance.destroy();
        }
    };
