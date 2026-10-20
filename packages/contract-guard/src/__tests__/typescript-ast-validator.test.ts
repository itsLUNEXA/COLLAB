import { describe, it, expect } from 'vitest';
import { TypeScriptAstValidator } from '../validators/typescript-ast-validator.js';
import { ContractConfidenceLevel } from '@collab/protocol';

describe('TypeScriptAstValidator (Safeguard 4 Compliance)', () => {
  const validator = new TypeScriptAstValidator();

  it('should validate a supported TypeScript interface declaration', async () => {
    const validInterface = {
      name: 'LoginResponse',
      properties: [
        { name: 'user_id', type: 'string', optional: false },
        { name: 'token', type: 'string', optional: false },
      ],
    };

    const result = await validator.validate(validInterface);
    expect(result.valid).toBe(true);
    expect(result.confidence).toBe(ContractConfidenceLevel.INFERRED_HIGH);
    expect(result.uncertain_inferred).toBe(false);
  });

  it('should explicitly mark dynamic or heuristic patterns as uncertain (Safeguard 4)', async () => {
    const dynamicPattern = {
      name: 'DynamicConfig',
      properties: [{ name: 'key', type: 'string', optional: false }],
      has_dynamic_properties: true, // Dynamic computed property detected
    };

    const result = await validator.validate(dynamicPattern);
    expect(result.confidence).toBe(ContractConfidenceLevel.INFERRED_UNCERTAIN);
    expect(result.uncertain_inferred).toBe(true);
    expect(result.warnings[0]).toContain('marked unverified for human review');
  });

  it('should detect breaking changes when an interface property is removed or type is changed', async () => {
    const prevPayload = {
      name: 'UserProfile',
      properties: [
        { name: 'id', type: 'string', optional: false },
        { name: 'age', type: 'number', optional: true },
      ],
    };

    const currPayload = {
      name: 'UserProfile',
      properties: [
        { name: 'id', type: 'number', optional: false }, // Type changed string -> number
        // 'age' removed
        { name: 'email', type: 'string', optional: false }, // New required property
      ],
    };

    const diff = await validator.compare(prevPayload, currPayload, 1, 2);
    expect(diff.has_breaking_changes).toBe(true);
    expect(diff.breaking_changes.length).toBeGreaterThanOrEqual(3);

    const removedAge = diff.breaking_changes.find((b) => b.message.includes("Property 'age' was removed"));
    expect(removedAge).toBeDefined();

    const changedId = diff.breaking_changes.find((b) => b.message.includes("changed type from 'string' to 'number'"));
    expect(changedId).toBeDefined();

    const addedRequiredEmail = diff.breaking_changes.find((b) => b.message.includes("Added new required property 'email'"));
    expect(addedRequiredEmail).toBeDefined();
  });
});
