import { describe, it, expect } from 'vitest';
import { ContractDiffEngine } from '../diff-engine.js';
import { ContractType, ErrorCode, CollabError } from '@collab/protocol';

describe('ContractDiffEngine', () => {
  const engine = new ContractDiffEngine();

  it('should dispatch to OpenApi validator for OPENAPI_ENDPOINT', async () => {
    const validDoc = {
      openapi: '3.1.0',
      paths: { '/test': { get: { responses: { '200': { description: 'OK' } } } } },
    };

    const result = await engine.validateContract(ContractType.OPENAPI_ENDPOINT, validDoc);
    expect(result.valid).toBe(true);
    expect(result.contract_type).toBe(ContractType.OPENAPI_ENDPOINT);
  });

  it('should dispatch to TypeScriptAstValidator for TYPESCRIPT_INTERFACE', async () => {
    const validInterface = {
      name: 'AuthResponse',
      properties: [{ name: 'token', type: 'string', optional: false }],
    };

    const result = await engine.validateContract(ContractType.TYPESCRIPT_INTERFACE, validInterface);
    expect(result.valid).toBe(true);
    expect(result.contract_type).toBe(ContractType.TYPESCRIPT_INTERFACE);
  });

  it('should throw CollabError for unsupported contract types', () => {
    expect(() =>
      engine.getValidator('UNKNOWN_CONTRACT_TYPE' as unknown as ContractType)
    ).toThrowError(CollabError);

    try {
      engine.getValidator('UNKNOWN_CONTRACT_TYPE' as unknown as ContractType);
    } catch (err) {
      expect((err as CollabError).code).toBe(ErrorCode.UNSUPPORTED_LANGUAGE_PATTERN);
    }
  });
});
