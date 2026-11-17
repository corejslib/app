import Api from "#core/api";

export default class PostgresqlInstance {
    #hostname;
    #api;
    #status;
    #role;
    #timeline;
    #lsn;

    constructor ( uri ) {
        const url = new URL( `ws://${ uri }` );

        this.#hostname = url.hostname;

        this.#api = new Api( url );
    }

    // properties
    get hostname () {
        return this.#hostname;
    }

    get api () {
        return this.#api;
    }

    get status () {
        return this.#status;
    }

    get role () {
        return this.#role;
    }

    get timeline () {
        return this.#timeline;
    }

    get lsn () {
        return this.#lsn;
    }

    // public
    async getStatus () {
        const res = await this.#api.call( "postgresql/instance/get-status" );

        return res;
    }

    async recover () {
        const res = await this.#api.call( "postgresql/instance/recover" );

        return res;
    }

    async start ( role, { replicationHostname } = {} ) {
        const res = await this.#api.call( "postgresql/instance/start", {
            role,
            replicationHostname,
        } );

        return res;
    }

    async stop () {
        const res = await this.#api.call( "postgresql/instance/stop" );

        return res;
    }
}
