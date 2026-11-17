export default Super =>
    class extends Super {

        // public
        async [ "API_get-status" ] ( ctx ) {
            return this.app.postgresql.cluster.getStatus();
        }

        async [ "API_recover" ] ( ctx ) {
            return this.app.postgresql.cluster.recoverCluster();
        }

        async [ "API_start" ] ( ctx, { role, replicationHostname } ) {
            return this.app.postgresql.cluster.startCluster( role, {
                replicationHostname,
            } );
        }

        async [ "API_stop" ] ( ctx ) {
            return this.app.postgresql.cluster.stopCluster();
        }
    };
