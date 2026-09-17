-- Canonical column ids are chosen by the admin screen, not by the
-- database, and they are slugs: `col-requirements`, `col-qa`. 0001 typed
-- them UUID, which nothing else in the system ever assumed — the hub
-- mints slugs, every fixture on both sides uses slugs, and the in-memory
-- ConfigStore the tests run against accepts any string. The first real
-- save was the first time that assumption met Postgres:
--
--   PUT /api/boards/{id}/columns  [{"id":"col-requirements",...}]  -> 500
--
-- The type was the outlier, so the type moves rather than every id in
-- the system. A readable id is worth keeping besides: `col-requirements`
-- says what it is in a log and a uuid does not. The default stays, so a
-- row inserted without an id still gets one.
--
-- column_mapping.canonical_column_id references this column and must
-- move with it. 0001 declared that reference inline without naming it,
-- so its name is whatever Postgres generated. Rather than hard-code a
-- name this migration cannot verify — the database is behind a firewall
-- that the authoring session could not reach — it looks the constraint
-- up and drops whichever foreign key is on that column.

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT con.conname INTO fk_name
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum = ANY (con.conkey)
     WHERE con.conrelid = 'column_mapping'::regclass
       AND con.contype = 'f'
       AND att.attname = 'canonical_column_id';

    IF fk_name IS NULL THEN
        RAISE EXCEPTION
            'no foreign key on column_mapping.canonical_column_id to drop';
    END IF;

    EXECUTE format(
        'ALTER TABLE column_mapping DROP CONSTRAINT %I', fk_name);
END
$$;

ALTER TABLE canonical_column
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN id TYPE TEXT USING id::text,
    ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

ALTER TABLE canonical_column
    ADD CONSTRAINT canonical_column_id_not_empty
        CHECK (length(id) > 0);

ALTER TABLE column_mapping
    ALTER COLUMN canonical_column_id TYPE TEXT USING canonical_column_id::text;

ALTER TABLE column_mapping
    ADD CONSTRAINT column_mapping_canonical_column_id_fkey
        FOREIGN KEY (canonical_column_id)
        REFERENCES canonical_column (id) ON DELETE CASCADE;
