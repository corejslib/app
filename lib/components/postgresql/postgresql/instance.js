import Api from "#core/api";

export default class PostgresqlInstance {
    #hostname;
    #api;

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
}
