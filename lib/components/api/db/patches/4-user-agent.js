import sql from "#core/sql";

export default sql`

ALTER TABLE api_session DROP COLUMN browser_major;

`;
