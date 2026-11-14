export default Super =>
    class extends Super {

        // public
        async [ "API_set-instance-status" ] ( ctx, { instanceId, remoteAddress, status, role, timeline, lsn } ) {
            this.app.postgresql.mamanger.setInstanceStatus( ctx.connection, {
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
