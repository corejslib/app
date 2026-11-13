import sql from "#core/sql";

export default sql`

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS user_email_normalize_nfc_casefold_trgm_idx ON "user" USING gin ( normalize_nfc_casefold( email ) gin_trgm_ops );

`;
