export default Super =>
    class extends Super {

        // public
        async [ "API_register-instance" ] ( ctx, { instanceId, remoteAddress, status, role, timeline, lsn } ) {
            this.app.postgresql.manager.registerInstance( ctx.connection, {
                instanceId,
                remoteAddress,
                status,
                role,
                timeline,
                lsn,
            } );

            return result( 200 );
        }
    };
