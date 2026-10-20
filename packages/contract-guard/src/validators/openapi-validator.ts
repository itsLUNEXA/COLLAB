/**
 * @file openapi-validator.ts
 * Validator for OpenAPI 3.0.x and 3.1.x specifications.
 * Identifies removed endpoints, removed response fields, and breaking type alterations.
 */

import {
  ContractType,
  ContractConfidenceLevel,
  BreakingChangeSeverity,
  BreakingChangeDetail,
} from '@collab/protocol';
import { IContractValidator, ContractValidationResult, ContractDiffResult } from '../types.js';

export class OpenApiContractValidator implements IContractValidator {
  public readonly validatorId = 'validator:openapi';
  public readonly supportedContractTypes = [ContractType.OPENAPI_ENDPOINT] as const;
  public readonly supportedLanguagesAndFrameworks = [
    'OpenAPI 3.0.x',
    'OpenAPI 3.1.x',
    'Swagger 2.0 (read-only)',
  ] as const;

  public async validate(rawPayload: unknown): Promise<ContractValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!rawPayload || typeof rawPayload !== 'object') {
      return {
        valid: false,
        contract_type: ContractType.OPENAPI_ENDPOINT,
        confidence: ContractConfidenceLevel.INFERRED_UNCERTAIN,
        supported_language_framework: 'OpenAPI 3.1.x',
        errors: ['Payload must be a non-null object'],
        warnings: [],
        uncertain_inferred: true,
      };
    }

    const doc = rawPayload as Record<string, unknown>;

    // Check version
    const openapiVer = doc.openapi || doc.swagger;
    if (!openapiVer || typeof openapiVer !== 'string') {
      errors.push('Missing required "openapi" or "swagger" version string');
    }

    // Check paths object
    if (!doc.paths || typeof doc.paths !== 'object') {
      errors.push('Missing or invalid "paths" object in OpenAPI document');
    }

    const isValid = errors.length === 0;

    return {
      valid: isValid,
      contract_type: ContractType.OPENAPI_ENDPOINT,
      confidence: isValid
        ? ContractConfidenceLevel.VERIFIED_EXPLICIT
        : ContractConfidenceLevel.INFERRED_UNCERTAIN,
      supported_language_framework: String(openapiVer ?? 'OpenAPI 3.1.x'),
      errors,
      warnings,
      extracted_schema: isValid ? doc : undefined,
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

    const prevPaths = (previousPayload.paths as Record<string, Record<string, unknown>>) || {};
    const currPaths = (currentPayload.paths as Record<string, Record<string, unknown>>) || {};

    // 1. Check for removed paths / endpoints
    for (const [pathKey, prevMethods] of Object.entries(prevPaths)) {
      if (!currPaths[pathKey]) {
        breakingChanges.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `paths.${pathKey}`,
          message: `Endpoint path '${pathKey}' was completely removed`,
        });
        continue;
      }

      const currMethods = currPaths[pathKey] || {};
      for (const [method, prevOperation] of Object.entries(prevMethods)) {
        if (!currMethods[method]) {
          breakingChanges.push({
            severity: BreakingChangeSeverity.BREAKING,
            path: `paths.${pathKey}.${method}`,
            message: `HTTP method '${method.toUpperCase()}' was removed from endpoint '${pathKey}'`,
          });
          continue;
        }

        // Compare response schemas
        this.compareResponses(
          pathKey,
          method,
          prevOperation as Record<string, unknown>,
          currMethods[method] as Record<string, unknown>,
          breakingChanges,
          nonBreakingChanges
        );
      }
    }

    // 2. Check for added paths (non-breaking)
    for (const [pathKey, currMethods] of Object.entries(currPaths)) {
      if (!prevPaths[pathKey]) {
        nonBreakingChanges.push(`Added new endpoint path '${pathKey}'`);
        continue;
      }
      for (const method of Object.keys(currMethods)) {
        if (!prevPaths[pathKey]?.[method]) {
          nonBreakingChanges.push(`Added new method '${method.toUpperCase()}' to '${pathKey}'`);
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

  private compareResponses(
    path: string,
    method: string,
    prevOp: Record<string, unknown>,
    currOp: Record<string, unknown>,
    breaking: BreakingChangeDetail[],
    nonBreaking: string[]
  ): void {
    const prevResponses = (prevOp.responses as Record<string, Record<string, unknown>>) || {};
    const currResponses = (currOp.responses as Record<string, Record<string, unknown>>) || {};

    for (const [status, prevRes] of Object.entries(prevResponses)) {
      if (!currResponses[status]) {
        breaking.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `paths.${path}.${method}.responses.${status}`,
          message: `Response code '${status}' was removed from '${method.toUpperCase()} ${path}'`,
        });
        continue;
      }

      // Check application/json schema fields
      const prevSchema = this.extractJsonSchema(prevRes);
      const currSchema = this.extractJsonSchema(currResponses[status]);

      if (prevSchema && currSchema) {
        this.compareSchemaProperties(
          `paths.${path}.${method}.responses.${status}`,
          prevSchema,
          currSchema,
          breaking,
          nonBreaking
        );
      }
    }
  }

  private extractJsonSchema(responseObj: Record<string, unknown>): Record<string, unknown> | null {
    const content = responseObj.content as Record<string, Record<string, unknown>> | undefined;
    if (content?.['application/json']?.schema) {
      return content['application/json'].schema as Record<string, unknown>;
    }
    if (responseObj.schema) {
      return responseObj.schema as Record<string, unknown>;
    }
    return null;
  }

  private compareSchemaProperties(
    prefix: string,
    prevSchema: Record<string, unknown>,
    currSchema: Record<string, unknown>,
    breaking: BreakingChangeDetail[],
    nonBreaking: string[]
  ): void {
    const prevProps = (prevSchema.properties as Record<string, Record<string, unknown>>) || {};
    const currProps = (currSchema.properties as Record<string, Record<string, unknown>>) || {};

    for (const [propName, prevPropDef] of Object.entries(prevProps)) {
      if (!currProps[propName]) {
        breaking.push({
          severity: BreakingChangeSeverity.BREAKING,
          path: `${prefix}.schema.properties.${propName}`,
          message: `Field '${propName}' was removed from response payload`,
          previous_type: String(prevPropDef.type ?? 'unknown'),
        });
      } else {
        const currPropDef = currProps[propName] || {};
        if (prevPropDef.type && currPropDef.type && prevPropDef.type !== currPropDef.type) {
          breaking.push({
            severity: BreakingChangeSeverity.BREAKING,
            path: `${prefix}.schema.properties.${propName}`,
            message: `Field '${propName}' changed type from '${prevPropDef.type}' to '${currPropDef.type}'`,
            previous_type: String(prevPropDef.type),
            current_type: String(currPropDef.type),
          });
        }
      }
    }

    for (const propName of Object.keys(currProps)) {
      if (!prevProps[propName]) {
        nonBreaking.push(`Added property '${propName}' to ${prefix}`);
      }
    }
  }
}
