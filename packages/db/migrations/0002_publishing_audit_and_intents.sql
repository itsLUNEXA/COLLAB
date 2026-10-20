-- ==============================================================================
-- Migration: 0002_publishing_audit_and_intents.sql
-- Description: Durable persistence for GitHub Publishing Audit Records and AI Module Intents
-- Enforces:
--   - Durable checkpoint publishing attempt history and audit trail (Safeguard 2)
--   - Durable AI agent module intent reservations with expiry and uniqueness constraints (Safeguard 4)
-- ==============================================================================

-- 1. Publishing Audit Records (Phase 5A)
CREATE TABLE IF NOT EXISTS publishing_audit_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    checkpoint_id UUID NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    target_branch VARCHAR(100) NOT NULL,
    base_sha VARCHAR(40),
    commit_sha VARCHAR(40),
    status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRYING')),
    attempt INT NOT NULL DEFAULT 1,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_publishing_audit_checkpoint ON publishing_audit_records(checkpoint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publishing_audit_project ON publishing_audit_records(project_id, created_at);

-- 2. Module Intents (Phase 5B: Shared AI Memory & Ownership)
CREATE TABLE IF NOT EXISTS module_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_name VARCHAR(100) NOT NULL,
    intent_description TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, module_name, device_id)
);

-- Dynamic constraint migration for pre-existing module_intents created under legacy draft schema
DO $$
DECLARE
    r RECORD;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'module_intents'
    ) THEN
        -- Drop any legacy unique constraint on module_intents that lacks device_id
        FOR r IN (
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE nsp.nspname = 'public'
              AND rel.relname = 'module_intents'
              AND con.contype = 'u'
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_attribute att
                  WHERE att.attrelid = con.conrelid
                    AND att.attnum = ANY(con.conkey)
                    AND att.attname = 'device_id'
              )
        ) LOOP
            EXECUTE 'ALTER TABLE module_intents DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;

        -- Drop any legacy standalone unique index on module_intents that lacks device_id
        FOR r IN (
            SELECT idx.relname as idxname
            FROM pg_index ind
            JOIN pg_class idx ON idx.oid = ind.indexrelid
            JOIN pg_class tbl ON tbl.oid = ind.indrelid
            JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
            WHERE nsp.nspname = 'public'
              AND tbl.relname = 'module_intents'
              AND ind.indisunique = true
              AND ind.indisprimary = false
              AND NOT EXISTS (
                  SELECT 1 FROM pg_constraint con WHERE con.conindid = ind.indexrelid
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_attribute att
                  WHERE att.attrelid = tbl.oid
                    AND att.attnum = ANY(ind.indkey)
                    AND att.attname = 'device_id'
              )
        ) LOOP
            EXECUTE 'DROP INDEX IF EXISTS ' || quote_ident(r.idxname);
        END LOOP;

        -- Ensure modern unique constraint on (project_id, module_name, device_id) is present
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE nsp.nspname = 'public'
              AND rel.relname = 'module_intents'
              AND con.contype = 'u'
              AND (
                  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
                  FROM pg_attribute att
                  WHERE att.attrelid = con.conrelid
                    AND att.attnum = ANY(con.conkey)
              ) = ARRAY['device_id', 'module_name', 'project_id']
        ) THEN
            ALTER TABLE module_intents 
            ADD CONSTRAINT module_intents_project_id_module_name_device_id_key 
            UNIQUE (project_id, module_name, device_id);
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_module_intents_lookup ON module_intents(project_id, module_name, device_id);
CREATE INDEX IF NOT EXISTS idx_module_intents_expiry ON module_intents(project_id, expires_at);
