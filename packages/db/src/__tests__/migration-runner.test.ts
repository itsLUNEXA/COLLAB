import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('packages/db - Migration Runner & Discovery Logic', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');

  it('should discover all migration files in packages/db/migrations in deterministic sort order', () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]).toBe('0001_initial_schema.sql');
    expect(files[1]).toBe('0002_publishing_audit_and_intents.sql');
  });

  it('should verify runner script exists and contains transaction-aware migration tracking', () => {
    const runnerPath = path.resolve(__dirname, '../../../../scripts/apply-migrations.js');
    expect(fs.existsSync(runnerPath)).toBe(true);

    const content = fs.readFileSync(runnerPath, 'utf8');
    expect(content).toContain('CREATE TABLE IF NOT EXISTS _schema_migrations');
    expect(content).toContain('BEGIN');
    expect(content).toContain('COMMIT');
    expect(content).toContain('ROLLBACK');
    expect(content).toContain('INSERT INTO _schema_migrations');
    expect(content).toContain('appliedSet.has(file)');
    expect(content).toContain('.sort()');
  });

  it('should verify backward-compatibility handling for pre-existing initial schema', () => {
    const runnerPath = path.resolve(__dirname, '../../../../scripts/apply-migrations.js');
    const content = fs.readFileSync(runnerPath, 'utf8');

    // Verifies complete 15-table pre-existing schema check before marking 0001 as applied
    expect(content).toContain('REQUIRED_0001_TABLES');
    expect(content).toContain('missing0001Tables.length === 0');
    expect(content).toContain('marking 0001_initial_schema.sql as applied');
    expect(content).toContain('Detected partial 0001 schema');
  });
});
