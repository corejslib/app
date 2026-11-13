import Api from "#lib/components/api/api";

export default Super =>
    class extends Super {

        // protected
        async _install () {
            return new Api( this.app, this.config );
        }

        async _configure () {
            const schema = this.components.getSchema( "api" );
            if ( !schema.ok ) return schema;

            return this.instance.configure( schema.data );
        }

        async _init () {
            return this.instance.init();
        }

        async _start () {
            return this.instance.start();
        }

        async _afterAppStarted () {

            // register service discovery
            this.app.cluster?.serviceDiscovery.addService( "api", this.app.components.get( "publicHttpServer" ).port, {
                "pathname": this.config.frontend.location,
            } );

            return result( 200 );
        }

        async _destroy () {
            await this.instance.destroy();
        }
    };
