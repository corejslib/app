export default Super =>
    class extends Super {

        // public
        async [ "API_get-status" ] ( ctx ) {
            return result( 200, this.app.postgresql.manager.getStatus() );
        }

        async [ "API_delete-cluster-old-version" ] ( ctx, { password } ) {
            if ( password !== this.app.postgresql.config.replication.password ) return result( 401 );

            return result( 200, this.app.postgresql.manager.deleteOldVersions() );
        }
    };
