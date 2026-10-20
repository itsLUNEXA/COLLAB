/**
 * @file typescript-ast-validator.ts
 * Validator for supported TypeScript interface and type declarations.
 * Enforces Safeguard 4: Explicitly declares supported patterns and flags dynamic/uncertain code as unverified.
 */

import {
  ContractType,
  ContractConfidenceLevel,
  BreakingChangeSeverity,
  BreakingChangeDetail,
} from '@collab/protocol';
import { IContractValidator, ContractValidationResult, ContractDiffResult } from '../types.js';

export interface TypeScriptTypeProperty {
  name: string;
  type: string;
  optional: boolean;
}

export class TypeScriptAstValidator implements IContractValidator {
  public readonly validatorId = 'validator:typescript-ast';
  public readonly supportedContractTypes = [ContractType.TYPESCRIPT_INTERFACE] as const;
  public readonly supportedLanguagesAndFrameworks = [
    'TypeScript 5.x (Standard AST)',
    'TypeScript Interface Declarations',
    'TypeScript Type Aliases',
  ] as const;

  // Explicitly declared supported code patterns (Safeguard 4)
  public readonly supportedPatterns = [
    'interface_declaration',
    'type_alias_object',
  ] as const;

  public async validate(rawPayload: unknown): Promise<ContractValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!rawPayload || typeof rawPayload !== 'object') {
      return {
        valid: false,
        contract_type: ContractType.TYPESCRIPT_INTERFACE,
        confidence: ContractConfidenceLevel.INFERRED_UNCERTAIN,
        supported_language_framework: 'TypeScript 5.x',
        errors: ['Payload must be a non-null object'],
        warnings: [],
        uncertain_inferred: true,
      };
    }

    const payload = rawPayload as Record<string, unknown>;
    const typeName = payload.name;
    const properties = payload.properties;
    const hasDynamicProperties = Boolean(payload.has_dynamic_properties);

    if (!typeName || typeof typeName !== 'string') {
      errors.push('Missing required "name" for TypeScript interface/type');
    }

    if (!Array.isArray(properties)) {
      errors.push('Missing or invalid "properties" array');
    }

    // Safeguard 4: Dynamic or unverified patterns MUST be marked uncertain
    if (hasDynamicProperties || payload.is_inferred_heuristic) {
      warnings.push(
        'Dynamic computed properties or heuristic inference detected; contract is marked unverified for human review.'
      );
      return {
        valid: errors.length === 0,
        contract_type: ContractType.TYPESCRIPT_INTERFACE,
        confidence: ContractConfidenceLevel.INFERRED_UNCERTAIN,
        supported_language_framework: 'TypeScript 5.x',
        errors,
        warnings,
        extracted_schema: payload,
        uncertain_inferred: true,
      };
    }

    const isValid = errors.length === 0;

    return {
      valid: isValid,
      contract_type: ContractType.TYPESCRIPT_INTERFACE,
      confidence: isValid
        ? ContractConfidenceLevel.INFERRED_HIGH
        : ContractConfidenceLevel.INFERRED_UNCERTAIN,
      supported_language_framework: 'TypeScript 5.x',
      errors,
      warnings,
      extracted_schema: isValid ? payload : undefined,
      uncertain_inferred: !isValid,
    };
  }

  public async compare(
    previousPayload: Record<string, unknown>,
    currentPayload: Record<string, unknown>,
    previousVersion: number,
    newVersion: number
  ): Promise<ContractDiffResult> {
    const breakingChanges: BreakingChangeDetail[] = [];
    const nonBreakingChanges: string[] = [];

    const prevProps = (previousPayload.properties as TypeScriptTypeProperty[]) || [];
    const currProps = (currentPayload.properties as TypeScriptTypeProperty[]) || [];

    const prevMap = new Map<string, TypeScriptTypeProperty>(prevProps.map((p) => [p.name, p]));
    const currMap = new Map<string, TypeScriptTypeProperty>(currProps.map((p) => [p.name, p]));

    // Check for removed properties
    for (const [name, prevProp] of prevMap.entries()) {
      const currProp = currMap.get(name);
      if (!currProp) {
        breakingChanges.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `interface.${String(previousPayload.name)}.${name}`,
          message: `Property '${name}' was removed from interface '${String(previousPayload.name)}'`,
          previous_type: prevProp.type,
        });
      } else if (prevProp.type !== currProp.type) {
        breakingChanges.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `interface.${String(previousPayload.name)}.${name}`,
          message: `Property '${name}' changed type from '${prevProp.type}' to '${currProp.type}'`,
          previous_type: prevProp.type,
          current_type: currProp.type,
        });
      } else if (!prevProp.optional && currProp.optional) {
        nonBreakingChanges.push(`Property '${name}' was made optional`);
      } else if (prevProp.optional && !currProp.optional) {
        breakingChanges.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `interface.${String(previousPayload.name)}.${name}`,
          message: `Property '${name}' was changed from optional to required`,
        });
      }
    }

    // Check for added properties
    for (const [name, currProp] of currMap.entries()) {
      if (!prevMap.has(name)) {
        if (!currProp.optional) {
          breakingChanges.push({
            severity: BreakingChangeSeverity.BREAKING,
            path: `interface.${String(currentPayload.name)}.${name}`,
            message: `Added new required property '${name}' to interface '${String(currentPayload.name)}'`,
            current_type: currProp.type,
          });
        } else {
          nonBreakingChanges.push(`Added new optional property '${name}'`);
        }
      }
    }

    return {
      has_breaking_changes: breakingChanges.length > 0,
      breaking_changes: breakingChanges,
      non_breaking_changes: nonBreakingChanges,
      previous_version: previousVersion,
      new_version: newVersion,
    };
  }
}
