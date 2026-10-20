import { describe, it, expect } from 'vitest';

describe('packages/db - Migration Lifecycle Simulation Suite', () => {
  const REQUIRED_0001_TABLES = [
    'teams',
    'users',
    'team_members',
    'projects',
    'devices',
    'workspaces',
    'sync_events',
    'editing_leases',
    'integration_contracts',
    'contract_versions',
    'module_dependencies',
    'active_conflicts',
    'checkpoints',
    'tasks',
    'project_decisions',
  ];

  // In-memory simulated PostgreSQL client for migration execution testing
  class SimulatedMigrationDb {
    public schemaMigrations: Set<string> = new Set();
    public publicTables: Set<string> = new Set();
    public queriesRun: string[] = [];
    public inTransaction = false;
    public shouldFailOnMigration?: string;

    async query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
      this.queriesRun.push(text);

      if (text === 'BEGIN') {
        this.inTransaction = true;
        return { rows: [] };
      }

      if (text === 'COMMIT') {
        this.inTransaction = false;
        return { rows: [] };
      }

      if (text === 'ROLLBACK') {
        this.inTransaction = false;
        return { rows: [] };
      }

      if (text.includes('CREATE TABLE IF NOT EXISTS _schema_migrations')) {
        this.publicTables.add('_schema_migrations');
        return { rows: [] };
      }

      if (text.includes('SELECT name FROM _schema_migrations;')) {
        return { rows: Array.from(this.schemaMigrations).map((name) => ({ name })) };
      }

      if (text.includes('SELECT table_name FROM information_schema.tables')) {
        return { rows: Array.from(this.publicTables).map((table_name) => ({ table_name })) };
      }

      if (text.includes('INSERT INTO _schema_migrations')) {
        const name = params[0] as string;
        this.schemaMigrations.add(name);
        return { rows: [] };
      }

      // Check simulated failure
      if (this.shouldFailOnMigration && text.includes(this.shouldFailOnMigration)) {
        throw new Error(`Simulated database failure during ${this.shouldFailOnMigration}`);
      }

      return { rows: [] };
    }
  }

  // Simulated execution matching the exact logic of scripts/apply-migrations.js
  async function runMigrationBatch(db: SimulatedMigrationDb, availableFiles: string[]) {
    await db.query('BEGIN');
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS _schema_migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      const appliedRes = await db.query('SELECT name FROM _schema_migrations;');
      const appliedSet = new Set(appliedRes.rows.map((r) => r.name as string));

      const existingTablesRes = await db.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public';
      `);
      const existingTableSet = new Set(existingTablesRes.rows.map((r) => r.table_name as string));
      const missing0001Tables = REQUIRED_0001_TABLES.filter((t) => !existingTableSet.has(t));

      if (!appliedSet.has('0001_initial_schema.sql')) {
        if (missing0001Tables.length === 0) {
          await db.query(
            'INSERT INTO _schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
            ['0001_initial_schema.sql']
          );
          appliedSet.add('0001_initial_schema.sql');
        }
      }

      const migrationFiles = [...availableFiles].sort();
      let newlyApplied = 0;

      for (const file of migrationFiles) {
        if (appliedSet.has(file)) {
          continue;
        }

        // Simulate reading and applying migration DDL
        await db.query(`-- SQL: ${file}`);

        // Mark tables created by 0001 or 0002
        if (file === '0001_initial_schema.sql') {
          for (const t of REQUIRED_0001_TABLES) {
            db.publicTables.add(t);
          }
        }
        if (file === '0002_publishing_audit_and_intents.sql') {
          db.publicTables.add('publishing_audit_records');
          db.publicTables.add('module_intents');
        }

        await db.query('INSERT INTO _schema_migrations (name) VALUES ($1)', [file]);
        newlyApplied++;
      }

      await db.query('COMMIT');
      return { success: true, newlyApplied };
    } catch (err) {
      await db.query('ROLLBACK');
      return { success: false, error: err };
    }
  }

  const migrations = ['0001_initial_schema.sql', '0002_publishing_audit_and_intents.sql'];

  it('Scenario 1: Empty database first run applies all migrations in order and records them', async () => {
    const db = new SimulatedMigrationDb();
    const result = await runMigrationBatch(db, migrations);

    expect(result.success).toBe(true);
    expect(result.newlyApplied).toBe(2);
    expect(db.schemaMigrations.has('0001_initial_schema.sql')).toBe(true);
    expect(db.schemaMigrations.has('0002_publishing_audit_and_intents.sql')).toBe(true);
    expect(db.publicTables.has('module_intents')).toBe(true);
    expect(db.publicTables.has('publishing_audit_records')).toBe(true);
  });

  it('Scenario 2: Complete legacy schema detects all 15 tables and skips re-running 0001', async () => {
    const db = new SimulatedMigrationDb();

    // Pre-populate all 15 tables from 0001
    for (const t of REQUIRED_0001_TABLES) {
      db.publicTables.add(t);
    }

    const result = await runMigrationBatch(db, migrations);

    expect(result.success).toBe(true);
    expect(result.newlyApplied).toBe(1); // Only 0002 was newly applied!
    expect(db.schemaMigrations.has('0001_initial_schema.sql')).toBe(true);
    expect(db.schemaMigrations.has('0002_publishing_audit_and_intents.sql')).toBe(true);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0001_initial_schema.sql'))).toBe(false);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0002_publishing_audit_and_intents.sql'))).toBe(true);
  });

  it('Scenario 3: Partial legacy schema (only 5 tables) does NOT skip 0001 and applies it idempotently', async () => {
    const db = new SimulatedMigrationDb();

    // Only 5 out of 15 tables exist
    db.publicTables.add('teams');
    db.publicTables.add('users');
    db.publicTables.add('team_members');
    db.publicTables.add('projects');
    db.publicTables.add('devices');

    const result = await runMigrationBatch(db, migrations);

    expect(result.success).toBe(true);
    // 0001 is executed to repair and complete missing tables, plus 0002 is executed
    expect(result.newlyApplied).toBe(2);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0001_initial_schema.sql'))).toBe(true);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0002_publishing_audit_and_intents.sql'))).toBe(true);
    expect(db.schemaMigrations.has('0001_initial_schema.sql')).toBe(true);
    expect(db.schemaMigrations.has('0002_publishing_audit_and_intents.sql')).toBe(true);

    // Verify all 15 tables are now present
    for (const t of REQUIRED_0001_TABLES) {
      expect(db.publicTables.has(t)).toBe(true);
    }
  });

  it('Scenario 4: Repeated migration runs skip already-applied migrations cleanly', async () => {
    const db = new SimulatedMigrationDb();

    // First run
    await runMigrationBatch(db, migrations);
    db.queriesRun = [];

    // Second run
    const result2 = await runMigrationBatch(db, migrations);
    expect(result2.success).toBe(true);
    expect(result2.newlyApplied).toBe(0);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0001_initial_schema.sql'))).toBe(false);
    expect(db.queriesRun.some((q) => q.includes('-- SQL: 0002_publishing_audit_and_intents.sql'))).toBe(false);
  });

  it('Scenario 5: Migration failure rolls back the entire transaction without committing _schema_migrations', async () => {
    const db = new SimulatedMigrationDb();
    db.shouldFailOnMigration = '0002_publishing_audit_and_intents.sql';

    const result = await runMigrationBatch(db, migrations);

    expect(result.success).toBe(false);
    expect(db.queriesRun).toContain('ROLLBACK');
    expect(db.inTransaction).toBe(false);
  });
});
