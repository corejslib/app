import Cluster from "./cluster.js";

export default Super =>
    class extends Super {

        // protected
        async _checkEnabled () {
            return this.config.enabled;
        }

        async _install () {
            return new Cluster( this.app, this.config );
        }

        async _init () {
            console.log( "[cluster] Connecting to the cluster" );

            await this.instance.waitConnect();

            console.log( "[cluster] Cluster connected" );

            return result( 200 );
        }
    };
