/**
 * @file types.ts
 * Core interfaces and result structures for contract validation and AST analysis.
 * Enforces Safeguard 4: Explicit declaration of supported languages and uncertainty markers.
 */

import {
  ContractType,
  ContractConfidenceLevel,
  BreakingChangeDetail,
} from '@collab/protocol';

export interface ContractValidationResult {
  valid: boolean;
  contract_type: ContractType;
  confidence: ContractConfidenceLevel;
  supported_language_framework: string;
  errors: string[];
  warnings: string[];
  extracted_schema?: Record<string, unknown>;
  uncertain_inferred: boolean;
}

export interface ContractDiffResult {
  has_breaking_changes: boolean;
  breaking_changes: BreakingChangeDetail[];
  non_breaking_changes: string[];
  previous_version: number;
  new_version: number;
}

export interface IContractValidator {
  readonly validatorId: string;
  readonly supportedContractTypes: readonly ContractType[];
  readonly supportedLanguagesAndFrameworks: readonly string[];

  /**
   * Validates a contract payload and returns confidence and structural errors.
   */
  validate(rawPayload: unknown): Promise<ContractValidationResult>;

  /**
   * Compares two versions of a contract and identifies breaking shifts.
   */
  compare(
    previousPayload: Record<string, unknown>,
    currentPayload: Record<string, unknown>,
    previousVersion: number,
    newVersion: number
  ): Promise<ContractDiffResult>;
}
