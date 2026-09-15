import sql from "#core/sql";

export default sql`

ALTER TABLE api_token ADD COLUMN public text;

ALTER TABLE api_session ADD COLUMN public text;

`;
