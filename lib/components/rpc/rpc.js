import Api from "#lib/api";
import Frontend from "#lib/api/frontend";

const COMPONENTS = {
    "frontend": Frontend,
};

export default class AppRpc extends Api {
    constructor ( app, config ) {
        super( app, config, COMPONENTS );
    }

    // properties
    get isRpc () {
        return true;
    }

    get httpServer () {
        return this.app.privateHttpServer;
    }
}
