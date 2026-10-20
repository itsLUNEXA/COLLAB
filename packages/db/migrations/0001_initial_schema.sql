-- ==============================================================================
-- Migration: 0001_initial_schema.sql
-- Description: Complete Relational Schema for Collaborative AI Coding Platform
-- Enforces Safeguards:
--   - Safeguard 1: Editing leases for active file protection
--   - Safeguard 2: WIP vs Verified integration checkpoints separation
--   - Safeguard 3: Immutable snapshot tree hashes
--   - Safeguard 5: Scoped device tokens & hashed local workspace paths
--   - Safeguard 7: Immutable contract version history
-- ==============================================================================

-- 1. Teams & Organizations
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users & Memberships
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(team_id, user_id)
);

-- 3. Projects & GitHub Connections
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    github_repo_owner VARCHAR(255),
    github_repo_name VARCHAR(255),
    github_installation_id BIGINT,
    default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
    wip_branch VARCHAR(100) NOT NULL DEFAULT 'collab/wip-sync',
    integrated_branch VARCHAR(100) NOT NULL DEFAULT 'collab/integrated',
    current_seq_num BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Registered Devices & Workspaces (Safeguard 5: Hashed Local Paths)
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(255) NOT NULL,
    os_info VARCHAR(100),
    device_token_hash VARCHAR(255) NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    local_path_hash VARCHAR(64) NOT NULL, -- SHA-256 of local absolute path (Safeguard 5)
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_synced_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, device_id)
);

-- 5. Synchronization Event Ledger
CREATE TABLE IF NOT EXISTS sync_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id),
    seq_num BIGINT NOT NULL,
    client_op_id UUID NOT NULL,
    relative_path TEXT NOT NULL,
    op_type VARCHAR(20) NOT NULL CHECK (op_type IN ('FILE_CREATE', 'FILE_UPDATE', 'FILE_DELETE', 'FILE_RENAME')),
    base_hash VARCHAR(64),
    target_hash VARCHAR(64) NOT NULL,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    is_binary BOOLEAN NOT NULL DEFAULT FALSE,
    content_blob TEXT,
    blob_storage_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, seq_num),
    UNIQUE(project_id, client_op_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_events_seq ON sync_events(project_id, seq_num);
CREATE INDEX IF NOT EXISTS idx_sync_events_path ON sync_events(project_id, relative_path);

-- 6. Editing Leases (Safeguard 1: Active File Protection)
CREATE TABLE IF NOT EXISTS editing_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    lease_status VARCHAR(20) NOT NULL CHECK (lease_status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
    handling_policy VARCHAR(30) NOT NULL CHECK (handling_policy IN ('ISOLATE_TO_SHADOW', 'AUTO_MERGE_IF_CLEAN', 'PROMPT_USER')),
    reason TEXT,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_editing_leases_active ON editing_leases(project_id, relative_path) WHERE lease_status = 'ACTIVE';

-- 7. Integration Contracts Registry (Active Head)
CREATE TABLE IF NOT EXISTS integration_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contract_type VARCHAR(50) NOT NULL CHECK (contract_type IN ('OPENAPI_ENDPOINT', 'JSON_SCHEMA', 'TYPESCRIPT_INTERFACE', 'DATABASE_SCHEMA', 'ENV_SPECIFICATION')),
    identifier VARCHAR(255) NOT NULL, -- e.g. "POST /api/v1/auth/login"
    owner_module VARCHAR(100) NOT NULL,
    current_version INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'STALE')),
    current_schema_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, identifier)
);

-- 8. Immutable Contract Version History (Safeguard 7)
CREATE TABLE IF NOT EXISTS contract_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES integration_contracts(id) ON DELETE CASCADE,
    version INT NOT NULL,
    identifier VARCHAR(255) NOT NULL,
    contract_type VARCHAR(50) NOT NULL,
    owner_module VARCHAR(100) NOT NULL,
    schema_definition JSONB NOT NULL,
    schema_hash VARCHAR(64) NOT NULL,
    confidence VARCHAR(30) NOT NULL CHECK (confidence IN ('VERIFIED_EXPLICIT', 'INFERRED_HIGH', 'INFERRED_UNCERTAIN')),
    supported_language_framework VARCHAR(100) NOT NULL,
    breaking_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_device_id UUID NOT NULL REFERENCES devices(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(contract_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contract_versions_lookup ON contract_versions(contract_id, version);

-- 9. Module Dependency Graph
CREATE TABLE IF NOT EXISTS module_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    consumer_module VARCHAR(100) NOT NULL, -- e.g. "frontend-auth"
    contract_id UUID NOT NULL REFERENCES integration_contracts(id) ON DELETE CASCADE,
    last_verified_version INT NOT NULL,
    is_stale BOOLEAN NOT NULL DEFAULT FALSE,
    stale_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, consumer_module, contract_id)
);

-- 10. Active Conflicts Ledger
CREATE TABLE IF NOT EXISTS active_conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    server_seq BIGINT NOT NULL,
    device_a_id UUID NOT NULL REFERENCES devices(id),
    device_b_id UUID NOT NULL REFERENCES devices(id),
    base_hash VARCHAR(64),
    remote_hash VARCHAR(64) NOT NULL,
    conflict_status VARCHAR(30) NOT NULL DEFAULT 'DETECTED' CHECK (conflict_status IN ('DETECTED', 'UNDER_REVIEW', 'RESOLVED_KEEP_LOCAL', 'RESOLVED_ACCEPT_REMOTE', 'RESOLVED_MERGED')),
    resolution_payload JSONB,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Checkpoints (Safeguards 2 & 3: WIP vs Verified Integration)
CREATE TABLE IF NOT EXISTS checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind VARCHAR(30) NOT NULL CHECK (kind IN ('WIP_SNAPSHOT', 'VERIFIED_INTEGRATION')),
    status VARCHAR(30) NOT NULL CHECK (status IN ('PENDING', 'RUNNING_CHECKS', 'PASSED', 'FAILED', 'PUBLISHED')),
    sync_sequence_num BIGINT NOT NULL,
    tree_sha256 VARCHAR(64) NOT NULL, -- Safeguard 3: Immutable tree hash
    file_count INT NOT NULL,
    manifest JSONB NOT NULL,
    validation_report JSONB,
    github_target_branch VARCHAR(100),
    github_commit_sha VARCHAR(40),
    commit_message TEXT,
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_lookup ON checkpoints(project_id, kind, status);

-- 12. Tasks and Project Decisions (Shared AI Memory)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    assigned_to_user_id UUID REFERENCES users(id),
    target_module VARCHAR(100),
    status VARCHAR(50) NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'REVIEW', 'DONE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    rationale TEXT NOT NULL,
    tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    decided_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
