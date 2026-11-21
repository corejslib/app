import Threads from "#core/threads";

export default Super =>
    class extends Super {

        // protected
        async _install () {
            return new Threads();
        }

        async _destroy () {
            return this.instance.destroy();
        }
    };
