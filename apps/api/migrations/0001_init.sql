-- 0001_init.sql
--
-- Config store schema. Spec: "Domain model and column mapping" plus the
-- audit rule in "Write path". This database holds board definitions,
-- column mappings, person overrides and the audit log, and deliberately
-- holds no work item content (spec: "Data at rest").
--
-- Applied migrations are immutable: the runner refuses to start when the
-- checksum of an applied file changes. Fix mistakes with a new file.

-- ---------------------------------------------------------------------
-- BoardDefinition: one per audience, e.g. "Delivery - all divisions".
-- ---------------------------------------------------------------------
CREATE TABLE board_definition (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL CHECK (length(name) > 0),
    org_id            TEXT NOT NULL CHECK (length(org_id) > 0),
    default_grouping  TEXT NOT NULL
        CHECK (default_grouping IN ('person', 'team')),
    owner_descriptor  TEXT NOT NULL CHECK (length(owner_descriptor) > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The board list screen reads every board of one organization.
CREATE INDEX board_definition_org_id_idx ON board_definition (org_id);

-- Two boards in one organization may not share a name.
CREATE UNIQUE INDEX board_definition_org_name_key
    ON board_definition (org_id, lower(name));

-- ---------------------------------------------------------------------
-- BoardSource: the set of team boards being merged.
-- A team is scoped to exactly one project, so (project, team, backlog
-- level) identifies one source board inside one definition.
-- ---------------------------------------------------------------------
CREATE TABLE board_source (
    board_id       UUID NOT NULL
        REFERENCES board_definition (id) ON DELETE CASCADE,
    project_id     TEXT NOT NULL CHECK (length(project_id) > 0),
    team_id        TEXT NOT NULL CHECK (length(team_id) > 0),
    backlog_level  TEXT NOT NULL CHECK (length(backlog_level) > 0),
    PRIMARY KEY (board_id, project_id, team_id, backlog_level)
);

-- Every board load resolves its sources first.
CREATE INDEX board_source_board_id_idx ON board_source (board_id);

-- ---------------------------------------------------------------------
-- CanonicalColumn: the columns our board declares, onto which each
-- team's own columns are mapped. `order` is unique per board and is
-- rewritten as a set, so the uniqueness is deferred to end of
-- transaction to allow a reorder in one statement batch.
-- ---------------------------------------------------------------------
CREATE TABLE canonical_column (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL
        REFERENCES board_definition (id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (length(name) > 0),
    "order"         INTEGER NOT NULL CHECK ("order" >= 0),
    state_category  TEXT NOT NULL
        CHECK (state_category IN ('Proposed', 'InProgress', 'Completed')),
    CONSTRAINT canonical_column_board_order_key
        UNIQUE (board_id, "order") DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT canonical_column_board_name_key
        UNIQUE (board_id, name) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX canonical_column_board_id_order_idx
    ON canonical_column (board_id, "order");

-- ---------------------------------------------------------------------
-- ColumnMapping: one team column mapped onto one canonical column.
-- Exactly one row per (board, team, source column) -- a team column can
-- never resolve to two canonical columns, which is what keeps the
-- "unmapped is never guessed" rule decidable.
-- ---------------------------------------------------------------------
CREATE TABLE column_mapping (
    board_id             UUID NOT NULL
        REFERENCES board_definition (id) ON DELETE CASCADE,
    team_id              TEXT NOT NULL CHECK (length(team_id) > 0),
    source_column_id     TEXT NOT NULL CHECK (length(source_column_id) > 0),
    canonical_column_id  UUID NOT NULL
        REFERENCES canonical_column (id) ON DELETE CASCADE,
    -- NULL means the move writes the board column alone.
    target_state         TEXT CHECK (target_state IS NULL
                                     OR length(target_state) > 0),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, team_id, source_column_id)
);

-- The read path loads every mapping of a board in one query; the write
-- path resolves the target column of one board back to team columns.
CREATE INDEX column_mapping_board_id_idx ON column_mapping (board_id);
CREATE INDEX column_mapping_canonical_column_id_idx
    ON column_mapping (canonical_column_id);

-- ---------------------------------------------------------------------
-- PersonOverride: display tidying for contractors and shared accounts.
-- Never correctness -- identity descriptors are stable org-wide.
-- ---------------------------------------------------------------------
CREATE TABLE person_override (
    board_id      UUID NOT NULL
        REFERENCES board_definition (id) ON DELETE CASCADE,
    descriptor    TEXT NOT NULL CHECK (length(descriptor) > 0),
    display_name  TEXT NOT NULL,
    hidden        BOOLEAN NOT NULL DEFAULT false,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, descriptor)
);

CREATE INDEX person_override_board_id_idx ON person_override (board_id);

-- ---------------------------------------------------------------------
-- AuditEntry: every write attempt, success or failure.
--
-- `board_id` carries no foreign key on purpose: the audit log outlives
-- the configuration it describes, and deleting a board definition must
-- never delete the record of who moved what. `actor` is an identity
-- descriptor, never a display name or an email.
--
-- The table is append-only; UPDATE and DELETE are refused by a trigger.
-- ---------------------------------------------------------------------
CREATE TABLE audit_entry (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID NOT NULL,
    actor           TEXT NOT NULL CHECK (length(actor) > 0),
    work_item_id    BIGINT NOT NULL CHECK (work_item_id > 0),
    -- Canonical column ids the card moved between.
    from_column_id  TEXT NOT NULL CHECK (length(from_column_id) > 0),
    to_column_id    TEXT NOT NULL CHECK (length(to_column_id) > 0),
    outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
    new_rev         INTEGER CHECK (new_rev IS NULL OR new_rev >= 0),
    state_changed   BOOLEAN,
    failure_reason  TEXT CHECK (failure_reason IS NULL OR failure_reason IN (
        'revision-conflict',
        'rule-violation',
        'transition-not-allowed',
        'permission-denied',
        'mapping-missing',
        'service-unavailable'
    )),
    -- The full MoveResult payload, as the hub received it.
    result          JSONB NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    trace_id        TEXT NOT NULL CHECK (length(trace_id) > 0),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_entry_outcome_shape CHECK (
        (outcome = 'success'
            AND new_rev IS NOT NULL
            AND state_changed IS NOT NULL
            AND failure_reason IS NULL)
        OR
        (outcome = 'failure'
            AND failure_reason IS NOT NULL
            AND new_rev IS NULL
            AND state_changed IS NULL)
    )
);

-- "Show me this board's recent moves" and support's "what happened to
-- work item 1234", both newest first; plus per-actor review for the
-- access review the ISMS asks for.
CREATE INDEX audit_entry_board_time_idx
    ON audit_entry (board_id, occurred_at DESC);
CREATE INDEX audit_entry_work_item_time_idx
    ON audit_entry (work_item_id, occurred_at DESC);
CREATE INDEX audit_entry_board_actor_time_idx
    ON audit_entry (board_id, actor, occurred_at DESC);
-- Retention sweeps run over the whole table by age.
CREATE INDEX audit_entry_time_idx ON audit_entry (occurred_at DESC);

CREATE FUNCTION audit_entry_is_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_entry is append-only (attempted %)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_no_update
    BEFORE UPDATE OR DELETE ON audit_entry
    FOR EACH ROW EXECUTE FUNCTION audit_entry_is_append_only();
