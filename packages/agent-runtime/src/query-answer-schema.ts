import { QUERY_ANSWER_SCHEMA_VERSION } from './query-answer.js';

export const QUERY_ANSWER_SCHEMA_ID = 'sheldon-query-answer/v1';

/** JSON Schema supplied to query adapters that need structured answer output. */
export const queryAnswerJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: QUERY_ANSWER_SCHEMA_ID,
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'question',
    'agent',
    'concepts',
    'raws',
    'createdAt',
    'truncated',
    'text',
  ],
  properties: {
    schemaVersion: { const: QUERY_ANSWER_SCHEMA_VERSION },
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' },
    question: { type: 'string', minLength: 1 },
    agent: { enum: ['codex', 'claude'] },
    concepts: { $ref: '#/$defs/citations' },
    raws: { $ref: '#/$defs/citations' },
    createdAt: { type: 'string', format: 'date-time' },
    truncated: {
      type: 'boolean',
      description:
        'Must exactly reflect whether matching index results were omitted from the selected context.',
    },
    text: { type: 'string', minLength: 1 },
  },
  $defs: {
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'citation'],
        properties: {
          path: { type: 'string', minLength: 1 },
          citation: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;
