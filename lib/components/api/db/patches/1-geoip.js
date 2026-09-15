import sql from "#core/sql";

export default sql`

ALTER TABLE api_session ADD COLUMN geoip_name text;

`;
