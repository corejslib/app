import Env from "./env.js";

export default Super =>
    class extends Super {

        // protected
        _install () {
            return new Env( this.app, this.config );
        }
    };
