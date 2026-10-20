import { describe, it, expect } from 'vitest';
import { OpenApiContractValidator } from '../validators/openapi-validator.js';
import { ContractConfidenceLevel, BreakingChangeSeverity } from '@collab/protocol';

describe('OpenApiContractValidator', () => {
  const validator = new OpenApiContractValidator();

  it('should validate a valid OpenAPI 3.1 document with VERIFIED_EXPLICIT confidence', async () => {
    const validDoc = {
      openapi: '3.1.0',
      info: { title: 'Auth API', version: '1.0.0' },
      paths: {
        '/api/v1/auth/login': {
          post: {
            responses: {
              '200': {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        user_id: { type: 'string' },
                        token: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = await validator.validate(validDoc);
    expect(result.valid).toBe(true);
    expect(result.confidence).toBe(ContractConfidenceLevel.VERIFIED_EXPLICIT);
    expect(result.errors).toHaveLength(0);
    expect(result.uncertain_inferred).toBe(false);
  });

  it('should reject a malformed document missing paths', async () => {
    const invalidDoc = {
      openapi: '3.1.0',
    };

    const result = await validator.validate(invalidDoc);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing or invalid "paths" object in OpenAPI document');
    expect(result.uncertain_inferred).toBe(true);
  });

  it('should detect breaking removal of endpoint and field name changes', async () => {
    const v1Doc = {
      openapi: '3.1.0',
      paths: {
        '/api/v1/auth/login': {
          post: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        userId: { type: 'string' },
                        token: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const v2Doc = {
      openapi: '3.1.0',
      paths: {
        '/api/v1/auth/login': {
          post: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        user_id: { type: 'string' }, // Renamed from userId
                        token: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const diff = await validator.compare(v1Doc, v2Doc, 1, 2);
    expect(diff.has_breaking_changes).toBe(true);
    expect(diff.breaking_changes).toHaveLength(1);
    expect(diff.breaking_changes[0].severity).toBe(BreakingChangeSeverity.BREAKING);
    expect(diff.breaking_changes[0].message).toContain("Field 'userId' was removed");
    expect(diff.non_breaking_changes).toContain("Added property 'user_id' to paths./api/v1/auth/login.post.responses.200");
  });
});
