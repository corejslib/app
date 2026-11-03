import Acme from "./acme.js";

export default Super =>
    class extends Super {

        // protected
        async _install () {
            return new Acme( this.app, this.config );
        }

        async _init () {
            return this.instance.init();
        }
    };
