import { describe, it, expect } from 'vitest';
import {
  ContractVersionRecordSchema,
  ContractType,
  ContractConfidenceLevel,
  BreakingChangeSeverity,
} from '../index.js';

describe('contracts.ts - Versioned Contract Schema & Confidence Levels', () => {
  const validContractId = '77777777-7777-4777-8777-777777777777';
  const validVersionId = '88888888-8888-4888-8888-888888888888';
  const validDeviceId = '11111111-1111-4111-8111-111111111111';
  const validHash = 'f'.repeat(64);

  it('should validate an immutable ContractVersionRecord with explicit confidence (Safeguard 4 & 7)', () => {
    const rawRecord = {
      id: validVersionId,
      contract_id: validContractId,
      version: 2,
      identifier: 'POST /api/v1/auth/login',
      contract_type: ContractType.OPENAPI_ENDPOINT,
      owner_module: 'backend-auth',
      schema_definition: {
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
                          user_id: { type: 'string' },
                          access_token: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      schema_hash: validHash,
      confidence: ContractConfidenceLevel.VERIFIED_EXPLICIT,
      supported_language_framework: 'OpenAPI 3.1',
      breaking_changes: [
        {
          severity: BreakingChangeSeverity.BREAKING,
          path: 'paths./api/v1/auth/login.post.responses.200.schema.properties.userId',
          message: "Field 'userId' was removed from response payload",
          previous_type: 'string',
        },
      ],
      created_by_device_id: validDeviceId,
      created_at_utc: new Date().toISOString(),
    };

    const parsed = ContractVersionRecordSchema.safeParse(rawRecord);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.version).toBe(2);
    expect(parsed.data?.confidence).toBe(ContractConfidenceLevel.VERIFIED_EXPLICIT);
    expect(parsed.data?.breaking_changes[0].severity).toBe(BreakingChangeSeverity.BREAKING);
  });
});
