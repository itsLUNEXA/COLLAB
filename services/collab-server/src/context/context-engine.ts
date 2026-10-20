/**
 * @file context-engine.ts
 * Shared AI Project Context Engine (Phase 5B).
 * Powers authoritative cross-agent context, breaking contract detection,
 * module ownership coordination, and integration verification.
 */

import crypto from 'node:crypto';
import {
  DbProject,
  DbIntegrationContract,
  DbContractVersion,
  DbModuleDependency,
  DbProjectDecision,
  DbModuleIntent,
} from '@collab/db';
import {
  ContractType,
  ContractStatus,
  ContractConfidenceLevel,
  ErrorCode,
  CollabError,
} from '@collab/protocol';
import { ContractDiffEngine } from '@collab/contract-guard';
import { ISyncRepository } from '../storage/sync-repository.interface.js';

export interface PublishContractInput {
  projectId: string;
  deviceId: string;
  identifier: string;
  contractType: ContractType;
  ownerModule: string;
  schemaDefinition: Record<string, unknown>;
  supportedLanguageFramework: string;
  confidence?: ContractConfidenceLevel;
}

export interface ClaimIntentInput {
  projectId: string;
  deviceId: string;
  userId: string;
  moduleName: string;
  intentDescription: string;
  ttlMinutes?: number;
}

export class SharedContextEngine {
  private diffEngine = new ContractDiffEngine();

  constructor(private repository: ISyncRepository) {}

  /**
   * 1. get_project_context
   * Returns authoritative shared context for AI coding agents.
   */
  public async getProjectContext(projectId: string): Promise<{
    project: {
      id: string;
      name: string;
      default_branch: string;
      wip_branch: string;
      integrated_branch: string;
      current_seq_num: number;
    };
    active_contracts: Array<{
      identifier: string;
      owner_module: string;
      version: number;
      status: string;
    }>;
    module_intents: Array<{
      module_name: string;
      device_id: string;
      intent_description: string;
      expires_at: string;
    }>;
    tasks: Array<{
      id: string;
      title: string;
      target_module: string | null;
      status: string;
    }>;
    recent_decisions: Array<{
      title: string;
      rationale: string;
      tags: string[];
      created_at: string;
    }>;
    freshness: {
      current_seq_num: number;
      active_conflicts_count: number;
      has_stale_contracts: boolean;
    };
  }> {
    const project = await this.getProjectOrThrow(projectId);

    const [contracts, intents, tasks, decisions, conflicts, dependencies] = await Promise.all([
      this.repository.listContracts(projectId),
      this.repository.listModuleIntents(projectId),
      this.repository.listTasks(projectId),
      this.repository.listProjectDecisions(projectId),
      this.repository.listActiveConflicts(projectId),
      this.repository.getModuleDependencies(projectId),
    ]);

    const hasStale = dependencies.some((d) => d.is_stale);

    return {
      project: {
        id: project.id,
        name: project.name,
        default_branch: project.default_branch,
        wip_branch: project.wip_branch,
        integrated_branch: project.integrated_branch,
        current_seq_num: project.current_seq_num,
      },
      active_contracts: contracts.map((c) => ({
        identifier: c.identifier,
        owner_module: c.owner_module,
        version: c.current_version,
        status: c.status,
      })),
      module_intents: intents.map((i) => ({
        module_name: i.module_name,
        device_id: i.device_id,
        intent_description: i.intent_description,
        expires_at: i.expires_at,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        target_module: t.target_module,
        status: t.status,
      })),
      recent_decisions: decisions.slice(0, 10).map((d) => ({
        title: d.title,
        rationale: d.rationale,
        tags: d.tags,
        created_at: d.created_at,
      })),
      freshness: {
        current_seq_num: project.current_seq_num,
        active_conflicts_count: conflicts.length,
        has_stale_contracts: hasStale,
      },
    };
  }

  /**
   * 2. get_api_contract
   * Retrieves a specific API contract definition, version history, and consumer staleness.
   */
  public async getApiContract(
    projectId: string,
    identifier: string,
    version?: number
  ): Promise<{
    contract: DbIntegrationContract;
    version: DbContractVersion;
    consumers: DbModuleDependency[];
  }> {
    await this.getProjectOrThrow(projectId);

    const contract = await this.repository.getContract(projectId, identifier);
    if (!contract) {
      throw new CollabError(ErrorCode.PROJECT_NOT_FOUND, `Contract '${identifier}' not found in project`);
    }

    const targetVersionNum = version ?? contract.current_version;
    const versionRecord = await this.repository.getContractVersion(contract.id, targetVersionNum);
    if (!versionRecord) {
      throw new CollabError(
        ErrorCode.CONTRACT_VERSION_MISMATCH,
        `Version ${targetVersionNum} for contract '${identifier}' not found`
      );
    }

    const consumers = await this.repository.getModuleDependencies(projectId, contract.id);

    return {
      contract,
      version: versionRecord,
      consumers,
    };
  }

  /**
   * 3. publish_api_contract
   * Publishes or updates an API contract, detects breaking changes, and flags stale consumers (Requirement 4).
   */
  public async publishApiContract(input: PublishContractInput): Promise<{
    contract: DbIntegrationContract;
    version: DbContractVersion;
    breakingChanges: unknown[];
    staleConsumersAffected: number;
  }> {
    await this.getProjectOrThrow(input.projectId);

    const canonicalSchema = JSON.stringify(input.schemaDefinition);
    const schemaHash = crypto.createHash('sha256').update(canonicalSchema).digest('hex');

    let contract = await this.repository.getContract(input.projectId, input.identifier);
    let nextVersion = 1;
    let breakingChanges: unknown[] = [];
    let staleConsumersCount = 0;

    let contractRecord: DbIntegrationContract;

    if (contract) {
      nextVersion = contract.current_version + 1;
      const prevVersionRecord = await this.repository.getContractVersion(contract.id, contract.current_version);

      if (prevVersionRecord) {
        // Detect breaking changes between versions (Safeguards 4 & 7)
        try {
          const diffResult = await this.diffEngine.computeDiff(
            input.contractType,
            prevVersionRecord.schema_definition,
            input.schemaDefinition,
            prevVersionRecord.version,
            nextVersion
          );
          breakingChanges = diffResult.breaking_changes;
        } catch {
          // If contract diffing fails gracefully, record empty or default
          breakingChanges = [];
        }

        // If breaking changes detected, mark affected consumer modules as stale (Requirement 4)
        if (breakingChanges.length > 0) {
          const reason = `Breaking change in ${input.identifier} v${nextVersion}: ${JSON.stringify(breakingChanges)}`;
          staleConsumersCount = await this.repository.markConsumersStale(input.projectId, contract.id, reason);
        }
      }

      contract.current_version = nextVersion;
      contract.current_schema_hash = schemaHash;
      contract.updated_at = new Date().toISOString();
      contractRecord = await this.repository.saveContract(contract);
    } else {
      // First version
      const contractId = crypto.randomUUID();
      contractRecord = await this.repository.saveContract({
        id: contractId,
        project_id: input.projectId,
        contract_type: input.contractType,
        identifier: input.identifier,
        owner_module: input.ownerModule,
        current_version: 1,
        status: ContractStatus.ACTIVE,
        current_schema_hash: schemaHash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // Save immutable contract version (Safeguard 7)
    const versionRecord: DbContractVersion = {
      id: crypto.randomUUID(),
      contract_id: contractRecord.id,
      version: nextVersion,
      identifier: input.identifier,
      contract_type: input.contractType,
      owner_module: input.ownerModule,
      schema_definition: input.schemaDefinition,
      schema_hash: schemaHash,
      confidence: input.confidence ?? ContractConfidenceLevel.VERIFIED_EXPLICIT,
      supported_language_framework: input.supportedLanguageFramework,
      breaking_changes: breakingChanges,
      created_by_device_id: input.deviceId,
      created_at: new Date().toISOString(),
    };
    await this.repository.saveContractVersion(versionRecord);

    return {
      contract: contractRecord,
      version: versionRecord,
      breakingChanges,
      staleConsumersAffected: staleConsumersCount,
    };
  }

  /**
   * 4. get_recent_changes
   * Returns recent file change events and checkpoints.
   */
  public async getRecentChanges(
    projectId: string,
    limit = 20,
    fromSeq = 0
  ): Promise<{
    project_id: string;
    events: Array<{
      seq_num: number;
      device_id: string;
      relative_path: string;
      op_type: string;
      created_at: string;
    }>;
    recent_checkpoints: Array<{
      id: string;
      kind: string;
      status: string;
      tree_sha256: string;
      commit_message: string | null;
      created_at: string;
    }>;
  }> {
    await this.getProjectOrThrow(projectId);

    const [events, checkpoints] = await Promise.all([
      this.repository.getEventsRange(projectId, fromSeq, Math.min(limit, 100)),
      this.repository.listCheckpoints(projectId),
    ]);

    return {
      project_id: projectId,
      events: events.map((e) => ({
        seq_num: e.seq_num,
        device_id: e.device_id,
        relative_path: e.relative_path,
        op_type: e.op_type,
        created_at: e.created_at,
      })),
      recent_checkpoints: checkpoints.slice(0, 5).map((cp) => ({
        id: cp.id,
        kind: cp.kind,
        status: cp.status,
        tree_sha256: cp.tree_sha256,
        commit_message: cp.commit_message,
        created_at: cp.created_at,
      })),
    };
  }

  /**
   * 5. record_project_decision
   * Records an architectural or integration decision for shared AI memory.
   */
  public async recordProjectDecision(input: {
    projectId: string;
    userId: string;
    title: string;
    rationale: string;
    tags?: string[];
  }): Promise<DbProjectDecision> {
    await this.getProjectOrThrow(input.projectId);

    const decision: DbProjectDecision = {
      id: crypto.randomUUID(),
      project_id: input.projectId,
      title: input.title,
      rationale: input.rationale,
      tags: input.tags ?? [],
      decided_by_user_id: input.userId,
      created_at: new Date().toISOString(),
    };

    return this.repository.saveProjectDecision(decision);
  }

  /**
   * 6. claim_module_intent
   * Declares active agent intent over a module to prevent concurrent collisions.
   */
  public async claimModuleIntent(input: ClaimIntentInput): Promise<{
    intent: DbModuleIntent;
    hasCollisionWarning: boolean;
    collisionWarningMessage?: string;
  }> {
    await this.getProjectOrThrow(input.projectId);

    const ttlMinutes = input.ttlMinutes ?? 120;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

    // Check for existing active intent from a different device
    const existingIntents = await this.repository.listModuleIntents(input.projectId);
    const colliding = existingIntents.find(
      (i) => i.module_name === input.moduleName && i.device_id !== input.deviceId
    );

    const intent: DbModuleIntent = {
      id: crypto.randomUUID(),
      project_id: input.projectId,
      device_id: input.deviceId,
      user_id: input.userId,
      module_name: input.moduleName,
      intent_description: input.intentDescription,
      acquired_at: now.toISOString(),
      expires_at: expiresAt,
    };

    await this.repository.claimModuleIntent(intent);

    return {
      intent,
      hasCollisionWarning: !!colliding,
      collisionWarningMessage: colliding
        ? `Warning: Teammate on device '${colliding.device_id}' has an active claim on '${input.moduleName}' ("${colliding.intent_description}")`
        : undefined,
    };
  }

  /**
   * 7. verify_integration_status
   * Assesses total system integration status across contracts, checkpoints, and conflicts.
   */
  public async verifyIntegrationStatus(projectId: string): Promise<{
    project_id: string;
    ready_to_publish: boolean;
    active_conflicts_count: number;
    stale_consumers: Array<{
      consumer_module: string;
      contract_id: string;
      stale_reason: string | null;
    }>;
    latest_checkpoint: {
      kind: string;
      status: string;
      tree_sha256: string;
      github_commit_sha: string | null;
    } | null;
    blocking_reasons: string[];
  }> {
    await this.getProjectOrThrow(projectId);

    const [conflicts, dependencies, checkpoints] = await Promise.all([
      this.repository.listActiveConflicts(projectId),
      this.repository.getModuleDependencies(projectId),
      this.repository.listCheckpoints(projectId),
    ]);

    const staleConsumers = dependencies
      .filter((d) => d.is_stale)
      .map((d) => ({
        consumer_module: d.consumer_module,
        contract_id: d.contract_id,
        stale_reason: d.stale_reason,
      }));

    const blockingReasons: string[] = [];
    if (conflicts.length > 0) {
      blockingReasons.push(`${conflicts.length} unresolved file merge conflicts exist`);
    }
    if (staleConsumers.length > 0) {
      blockingReasons.push(`${staleConsumers.length} module consumers have stale, unverified contracts`);
    }

    const latestCheckpoint = checkpoints[0]
      ? {
          kind: checkpoints[0].kind,
          status: checkpoints[0].status,
          tree_sha256: checkpoints[0].tree_sha256,
          github_commit_sha: checkpoints[0].github_commit_sha,
        }
      : null;

    const readyToPublish = blockingReasons.length === 0;

    return {
      project_id: projectId,
      ready_to_publish: readyToPublish,
      active_conflicts_count: conflicts.length,
      stale_consumers: staleConsumers,
      latest_checkpoint: latestCheckpoint,
      blocking_reasons: blockingReasons,
    };
  }

  private async getProjectOrThrow(projectId: string): Promise<DbProject> {
    const project = await this.repository.getProject(projectId);
    if (!project) {
      throw new CollabError(ErrorCode.PROJECT_NOT_FOUND, `Project '${projectId}' not found`);
    }
    return project;
  }
}
