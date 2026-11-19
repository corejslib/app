import Api from "#core/api";

export default class PostgresqlInstance {
    #hostname;
    #api;
    #status = null;
    #busy = false;
    #role = null;
    #version = null;
    #timeline = null;
    #lsn = null;
    #history = null;
    #standby = false;

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

    // null - status is unknown (instance is unreachable)
    get status () {
        return this.#status;
    }

    get busy () {
        return this.#busy;
    }

    get role () {
        return this.#role;
    }

    // major version of the data dir, that is in use (it is the old version, until the cluster is upgraded), null - there is no data dir
    get version () {
        return this.#version;
    }

    get timeline () {
        return this.#timeline;
    }

    get lsn () {
        return this.#lsn;
    }

    // list of ancestors of the timeline: [ { timeline, lsn } ], where lsn is the point, where the history left this timeline
    get history () {
        return this.#history;
    }

    get standby () {
        return this.#standby;
    }

    // public
    async getStatus () {
        const res = await this.#api.call( "postgresql/instance/get-status" );

        return this.#updateStatus( res );
    }

    async recover () {
        const res = await this.#api.call( "postgresql/instance/recover" );

        return this.#updateStatus( res );
    }

    async start ( role, { replicationHostname } = {} ) {
        const res = await this.#api.call( "postgresql/instance/start", {
            role,
            replicationHostname,
        } );

        return this.#updateStatus( res );
    }

    async stop () {
        const res = await this.#api.call( "postgresql/instance/stop" );

        return this.#updateStatus( res );
    }

    // private
    // all instance methods return the actual instance status in the res.data, even if the call failed
    #updateStatus ( res ) {
        const data = res.data ?? {};

        this.#status = data.status ?? null;
        this.#busy = data.busy ?? false;
        this.#role = data.role ?? null;
        this.#version = data.version ?? null;
        this.#timeline = data.timeline ?? null;
        this.#lsn = data.lsn ?? null;
        this.#history = data.history ?? null;
        this.#standby = data.standby ?? false;

        return res;
    }
}
