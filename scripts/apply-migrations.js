#!/usr/bin/env node
/**
 * @file apply-migrations.js
 * Safely connects to PostgreSQL (local or Supabase) and applies 0001_initial_schema.sql.
 * Redacts secrets from logs and seeds initial development records idempotently.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Simple .env parser to avoid extra runtime dependencies
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

function redactUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return 'postgresql://[REDACTED]';
  }
}

async function main() {
  const envFromFile = loadEnvFile(path.join(rootDir, '.env'));
  const databaseUrl = process.env.DATABASE_URL || envFromFile.DATABASE_URL;

  if (!databaseUrl) {
    console.error('========================================================================');
    console.error('[ERROR] DATABASE_URL is not set.');
    console.error('Please configure DATABASE_URL in your .env file before running migrations.');
    console.error('Example: DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"');
    console.error('========================================================================');
    process.exit(1);
  }

  const isLocalhost = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const ssl = isLocalhost ? false : { rejectUnauthorized: false };

  console.log('Connecting to PostgreSQL database:', redactUrl(databaseUrl));

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl,
  });

  try {
    await client.connect();
    console.log('[+] Connected successfully to PostgreSQL.');

    console.log('[*] Initializing migration transaction...');
    await client.query('BEGIN');

    // 1. Transaction-aware migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const appliedRes = await client.query('SELECT name FROM _schema_migrations;');
    const appliedSet = new Set(appliedRes.rows.map((r) => r.name));

    // 2. Backward compatibility: Check whether 0001 schema is demonstrably complete and compatible
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

    const REQUIRED_0001_COLUMNS = {
      teams: ['id', 'name'],
      users: ['id', 'email', 'name'],
      team_members: ['team_id', 'user_id', 'role'],
      projects: ['id', 'team_id', 'name', 'default_branch', 'current_seq_num'],
      devices: ['id', 'user_id', 'device_token_hash', 'is_revoked'],
      workspaces: ['id', 'project_id', 'device_id', 'local_path_hash'],
      sync_events: ['id', 'project_id', 'seq_num', 'client_op_id', 'op_type', 'target_hash'],
      editing_leases: ['id', 'project_id', 'device_id', 'relative_path', 'expires_at'],
      integration_contracts: ['id', 'project_id', 'identifier', 'current_version', 'status'],
      contract_versions: ['id', 'contract_id', 'version', 'schema_hash'],
      module_dependencies: ['id', 'project_id', 'consumer_module', 'contract_id'],
      active_conflicts: ['id', 'project_id', 'relative_path', 'conflict_status'],
      checkpoints: ['id', 'project_id', 'kind', 'status', 'tree_sha256'],
      tasks: ['id', 'project_id', 'title', 'status'],
      project_decisions: ['id', 'project_id', 'title', 'decided_by_user_id'],
    };

    const existingTablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    const existingTableSet = new Set(existingTablesRes.rows.map((r) => r.table_name));
    const missing0001Tables = REQUIRED_0001_TABLES.filter((t) => !existingTableSet.has(t));

    // Verify columns for existing tables
    const colsRes = await client.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public';
    `);
    const existingColsMap = new Map();
    for (const r of colsRes.rows) {
      if (!existingColsMap.has(r.table_name)) existingColsMap.set(r.table_name, new Set());
      existingColsMap.get(r.table_name).add(r.column_name);
    }

    let missingColsCount = 0;
    for (const [table, requiredCols] of Object.entries(REQUIRED_0001_COLUMNS)) {
      if (existingTableSet.has(table)) {
        const tableCols = existingColsMap.get(table) || new Set();
        for (const col of requiredCols) {
          if (!tableCols.has(col)) {
            missingColsCount++;
            console.warn(`[!] Table ${table} is missing required column: ${col}`);
          }
        }
      }
    }

    // Verify key constraints on existing tables
    const constraintsRes = await client.query(`
      SELECT con.conname, con.contype, rel.relname as tablename
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public';
    `);
    const uniqueConstraintTables = new Set(
      constraintsRes.rows
        .filter((c) => c.contype === 'u' || c.contype === 'p')
        .map((c) => c.tablename)
    );
    const criticalTablesWithKeys = ['users', 'team_members', 'workspaces', 'sync_events'];
    const missingConstraints = criticalTablesWithKeys.filter(
      (t) => existingTableSet.has(t) && !uniqueConstraintTables.has(t)
    );

    if (missingColsCount > 0 || missingConstraints.length > 0) {
      throw new Error(
        `Incompatible pre-existing schema detected: ${missingColsCount} missing column(s), ${missingConstraints.length} missing constraint(s) on existing tables. Cannot automatically recover incompatible schema.`
      );
    }

    if (!appliedSet.has('0001_initial_schema.sql')) {
      if (missing0001Tables.length === 0) {
        console.log('[*] Detected complete and compatible pre-existing 0001 schema (all 15 tables, columns, and constraints verified); marking 0001_initial_schema.sql as applied.');
        await client.query(
          'INSERT INTO _schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          ['0001_initial_schema.sql']
        );
        appliedSet.add('0001_initial_schema.sql');
      } else {
        console.log(`[!] Detected partial 0001 schema (missing ${missing0001Tables.length} tables). Executing 0001_initial_schema.sql to safely complete/repair schema...`);
        // Do NOT mark as applied yet; the migration runner loop will execute 0001 to repair schema idempotently
      }
    }

    // 3. Discover all migration files in packages/db/migrations in deterministic order
    const migrationsDir = path.join(rootDir, 'packages', 'db', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migration directory not found at: ${migrationsDir}`);
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // Deterministic alphabetical/numeric order: 0001_..., 0002_...

    console.log(`[*] Discovered ${migrationFiles.length} migration file(s) in: ${migrationsDir}`);

    let newlyAppliedCount = 0;
    for (const file of migrationFiles) {
      if (appliedSet.has(file)) {
        console.log(`[-] Migration already applied (skipping): ${file}`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      console.log(`[*] Applying migration: ${file}`);
      const sql = fs.readFileSync(filePath, 'utf8');
      await client.query(sql);

      await client.query(
        'INSERT INTO _schema_migrations (name) VALUES ($1)',
        [file]
      );
      newlyAppliedCount++;
      console.log(`[+] Successfully applied: ${file}`);
    }

    // 4. Seed default team and project for development idempotently (never overwrite existing remote records)
    const teamId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    const defaultProjectId = '11111111-1111-4111-8111-111111111111';

    await client.query(`
      INSERT INTO teams (id, name)
      VALUES ($1, 'Hackathon Dev Team')
      ON CONFLICT (id) DO NOTHING;
    `, [teamId]);

    // Check if user already exists by ID or email to avoid unique constraint conflict
    const existingUserRes = await client.query(
      'SELECT id FROM users WHERE id = $1 OR email = $2 LIMIT 1;',
      [userId, 'dev@antigravity.local']
    );
    let effectiveUserId = userId;
    if (existingUserRes.rows.length > 0) {
      effectiveUserId = existingUserRes.rows[0].id;
    } else {
      await client.query(`
        INSERT INTO users (id, email, name)
        VALUES ($1, 'dev@antigravity.local', 'Primary Developer')
        ON CONFLICT (id) DO NOTHING;
      `, [userId]);
    }

    await client.query(`
      INSERT INTO team_members (team_id, user_id, role)
      VALUES ($1, $2, 'OWNER')
      ON CONFLICT (team_id, user_id) DO NOTHING;
    `, [teamId, effectiveUserId]);

    const repoOwner = process.env.GITHUB_REPO_OWNER || envFromFile.GITHUB_REPO_OWNER || 'itsLUNEXA';
    const repoName = process.env.GITHUB_REPO_NAME || envFromFile.GITHUB_REPO_NAME || 'COLLAB';
    const rawInstId = process.env.GITHUB_INSTALLATION_ID || envFromFile.GITHUB_INSTALLATION_ID;
    const installationId = rawInstId ? parseInt(rawInstId, 10) : 173318191;

    // Use ON CONFLICT (id) DO NOTHING to preserve existing remote project configuration
    await client.query(`
      INSERT INTO projects (
        id, team_id, name, github_repo_owner, github_repo_name, github_installation_id,
        default_branch, wip_branch, integrated_branch, current_seq_num
      ) VALUES ($1, $2, 'Collaborative AI Platform (Supabase DB)', $3, $4, $5, 'main', 'collab/wip', 'collab/integrated', 0)
      ON CONFLICT (id) DO NOTHING;
    `, [defaultProjectId, teamId, repoOwner, repoName, installationId]);

    const defaultDeviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const devDeviceSecretHash = crypto.createHash('sha256').update('collab-dev-device-secret-key').digest('hex');

    await client.query(`
      INSERT INTO devices (id, user_id, device_name, device_token_hash)
      VALUES ($1, $2, 'Primary Dev Workstation', $3)
      ON CONFLICT (id) DO NOTHING;
    `, [defaultDeviceId, effectiveUserId, devDeviceSecretHash]);

    await client.query('COMMIT');
    console.log(`[+] Migration batch complete. Newly applied: ${newlyAppliedCount}.`);

    // Query information_schema to verify created tables
    const tableRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tableNames = tableRes.rows.map(r => r.table_name);
    console.log(`[+] Verified ${tableNames.length} tables in public schema:`);
    console.log('    ' + tableNames.join(', '));

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('========================================================================');
    console.error('[ERROR] Migration failed:', err.message || err.code || String(err));
    console.error('========================================================================');
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error:', err);
  process.exit(1);
});
