import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('packages/db - Migration Integrity & Schema Structure', () => {
  const migrationPath = path.resolve(__dirname, '../../migrations/0001_initial_schema.sql');

  it('should verify that 0001_initial_schema.sql exists and is non-empty', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql.length).toBeGreaterThan(1000);
  });

  it('should contain all required entity tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    const expectedTables = [
      'teams',
      'users',
      'team_members',
      'projects',
      'devices',
      'workspaces',
      'sync_events',
      'editing_leases', // Safeguard 1
      'integration_contracts',
      'contract_versions', // Safeguard 7
      'module_dependencies',
      'active_conflicts',
      'checkpoints', // Safeguards 2 & 3
      'tasks',
      'project_decisions',
    ];

    for (const table of expectedTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('should enforce immutable contract history (Safeguard 7)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain('contract_versions');
    expect(sql).toContain('UNIQUE(contract_id, version)');
    expect(sql).toContain('confidence VARCHAR(30) NOT NULL');
  });

  it('should enforce snapshot tree hashes on checkpoints (Safeguard 3)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain('tree_sha256 VARCHAR(64) NOT NULL');
    expect(sql).toContain("kind IN ('WIP_SNAPSHOT', 'VERIFIED_INTEGRATION')");
  });

  it('should enforce editing leases and policies (Safeguard 1)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain('editing_leases');
    expect(sql).toContain("handling_policy IN ('ISOLATE_TO_SHADOW', 'AUTO_MERGE_IF_CLEAN', 'PROMPT_USER')");
  });

  const migration0002Path = path.resolve(__dirname, '../../migrations/0002_publishing_audit_and_intents.sql');

  it('should verify that 0002_publishing_audit_and_intents.sql exists and is non-empty', () => {
    expect(fs.existsSync(migration0002Path)).toBe(true);
    const sql = fs.readFileSync(migration0002Path, 'utf-8');
    expect(sql.length).toBeGreaterThan(500);
  });

  it('should define publishing_audit_records and module_intents with proper constraints', () => {
    const sql = fs.readFileSync(migration0002Path, 'utf-8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS publishing_audit_records');
    expect(sql).toContain('REFERENCES projects(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES checkpoints(id) ON DELETE CASCADE');
    expect(sql).toContain("status IN ('SUCCESS', 'FAILED', 'RETRYING')");
    expect(sql).toContain('idx_publishing_audit_checkpoint');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS module_intents');
    expect(sql).toContain('REFERENCES devices(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES users(id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE(project_id, module_name, device_id)');
    expect(sql).toContain('idx_module_intents_lookup');
    expect(sql).toContain('idx_module_intents_expiry');
    expect(sql).toContain('pg_constraint');
    expect(sql).toContain('DROP CONSTRAINT');
    expect(sql).toContain('module_intents_project_id_module_name_device_id_key');
  });

  it('should cast att.attname to text in module_intents dynamic catalog check to prevent PostgreSQL name[] = text[] mismatch', () => {
    const sql = fs.readFileSync(migration0002Path, 'utf-8');
    expect(sql).toContain('array_agg(att.attname::text ORDER BY att.attname::text)');
    expect(sql).not.toMatch(/array_agg\(\s*att\.attname\s+ORDER/);
  });
});
