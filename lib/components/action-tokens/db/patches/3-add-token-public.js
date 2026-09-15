import sql from "#core/sql";

export default sql`

ALTER TABLE action_token ADD COLUMN public text;

`;
