import NginxUpstream from "./nginx-upstream.js";

export default Super =>
    class extends Super {

        // protected
        async _checkEnabled () {
            return this.config.enabled;
        }

        async _install () {
            return new NginxUpstream( this.app, this.config );
        }

        async _init () {
            return this.instance.init();
        }

        async _destroy () {
            this.instance.destroy();
        }
    };
