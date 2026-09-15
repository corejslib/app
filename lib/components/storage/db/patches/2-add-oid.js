import sql from "#core/sql";

export default sql`

ALTER TABLE storage_image ADD COLUMN oid oid UNIQUE;

`;
