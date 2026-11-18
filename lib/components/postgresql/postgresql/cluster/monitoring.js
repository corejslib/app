import sql from "#core/sql";
import { sleep } from "#core/utils";
import { ROLE } from "../utils.js";

export default class PostgresqlClusterMonitoring {
    #cluster;
    #started;
    #dbh;
    #abortController;

    constructor ( cluster ) {
        this.#cluster = cluster;
    }

    // public
    start () {
        if ( this.#started ) return;
        this.#started = true;

        this.#abortController = new AbortController();
        this.#dbh = sql.new( "postgresql:" );

        this.#start( this.#abortController.signal );
    }

    stop () {
        if ( !this.#started ) return;
        this.#started = false;

        this.#abortController.abort();
        this.#abortController = null;

        this.#dbh.forceDestroy();
        this.#dbh = null;
    }

    // private
    // XXX inmplement
    #start ( signal ) {
        while ( true ) {
            if ( !this.#started ) break;

            // XXX methods to use
            //
            // this.#dbh.isConnected -> boolean
            //
            // const connected = await this.#dbh.waitConnect( { signal } )
            // if (!connected) ...
            //
            // await sleep(1000, {signal})

            if ( this.#cluster.role === ROLE.PRIMARY ) {

                // XXX
            }
            else {

                // XXX standby
            }
        }
    }
}

// -----BEGIN LINT LOG-----
// +----------+----------+----------------------------------------------------------------------------+
// | Severity |     Line | Desctiption                                                                |
// |==========+==========+============================================================================|
// | ERROR    |     2:10 | no-unused-vars, 'sleep' is defined but never used.                         |
// +----------+----------+----------------------------------------------------------------------------+
// -----END LINT LOG-----
