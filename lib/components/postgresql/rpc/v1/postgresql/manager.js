export default Super =>
    class extends Super {

        // public
        async [ "API_get-status" ] ( ctx ) {
            return result( 200, this.app.postgresql.manager.getStatus() );
        }
    };
