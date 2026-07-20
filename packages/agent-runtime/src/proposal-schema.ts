import { PROPOSAL_SCHEMA_VERSION } from './proposal.js';

export const STRUCTURED_PROPOSAL_SCHEMA_ID = 'sheldon-proposal/v1';
export const AGENT_PROMPT_VERSION = 'm2/v1';

/**
 * The wire schema passed directly to agent CLIs. Keep this independent of the
 * runtime validator: a model response is always treated as untrusted input.
 */
export const structuredProposalJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: STRUCTURED_PROPOSAL_SCHEMA_ID,
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'files', 'sources'],
  properties: {
    schemaVersion: { const: PROPOSAL_SCHEMA_VERSION },
    id: { type: 'string', minLength: 1, maxLength: 128 },
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'operation', 'citations'],
        properties: {
          path: { type: 'string', minLength: 1 },
          operation: { enum: ['create', 'modify', 'delete'] },
          content: { type: 'string' },
          citations: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    sources: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rawPath', 'citation'],
        properties: {
          rawPath: { type: 'string', minLength: 1 },
          citation: { type: 'string', minLength: 1 },
        },
      },
    },
    claims: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    confidence: { enum: ['low', 'medium', 'high'] },
  },
} as const;
