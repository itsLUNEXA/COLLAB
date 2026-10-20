/**
 * @file diff-engine.ts
 * High-level diff engine dispatcher for evaluating semantic contract versions.
 */

import { ContractType, CollabError, ErrorCode } from '@collab/protocol';
import { IContractValidator, ContractDiffResult, ContractValidationResult } from './types.js';
import { OpenApiContractValidator } from './validators/openapi-validator.js';
import { TypeScriptAstValidator } from './validators/typescript-ast-validator.js';

export class ContractDiffEngine {
  private readonly validators = new Map<ContractType, IContractValidator>();

  constructor() {
    const openApi = new OpenApiContractValidator();
    for (const t of openApi.supportedContractTypes) {
      this.validators.set(t, openApi);
    }

    const tsAst = new TypeScriptAstValidator();
    for (const t of tsAst.supportedContractTypes) {
      this.validators.set(t, tsAst);
    }
  }

  public getValidator(type: ContractType): IContractValidator {
    const v = this.validators.get(type);
    if (!v) {
      throw new CollabError(
        ErrorCode.UNSUPPORTED_LANGUAGE_PATTERN,
        `No registered contract validator for contract type: ${type}`
      );
    }
    return v;
  }

  public async validateContract(
    type: ContractType,
    payload: unknown
  ): Promise<ContractValidationResult> {
    const validator = this.getValidator(type);
    return validator.validate(payload);
  }

  public async computeDiff(
    type: ContractType,
    previous: Record<string, unknown>,
    current: Record<string, unknown>,
    prevVersion: number,
    currVersion: number
  ): Promise<ContractDiffResult> {
    const validator = this.getValidator(type);
    return validator.compare(previous, current, prevVersion, currVersion);
  }
}
