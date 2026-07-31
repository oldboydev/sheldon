export const operationNames = ['describe', 'probe', 'ingest', 'healthcheck', 'cancel'] as const;
export const responseStatuses = ['success', 'error', 'cancelled'] as const;

export const jsonValueSchema = {
  $id: 'https://sheldon.local/schemas/json-value-v1',
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: 'https://sheldon.local/schemas/json-value-v1' } },
    {
      type: 'object',
      additionalProperties: { $ref: 'https://sheldon.local/schemas/json-value-v1' },
    },
  ],
} as const;

const jsonValueRef = { $ref: 'https://sheldon.local/schemas/json-value-v1' } as const;
const jsonRecordSchema = {
  type: 'object',
  additionalProperties: jsonValueRef,
} as const;
const identifierSchema = {
  type: 'string',
  pattern: '^[a-z0-9]+(?:[.-][a-z0-9]+)*$',
} as const;
const nonEmptyStringSchema = { type: 'string', minLength: 1 } as const;
const artifactRoles = ['original', 'normalized', 'asset', 'inventory', 'metadata'] as const;
const platformNames = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
] as const;

const commandSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['executable', 'arguments'],
  properties: {
    executable: nonEmptyStringSchema,
    arguments: { type: 'array', items: nonEmptyStringSchema },
  },
} as const;

const dependencySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'required', 'remediation'],
  properties: {
    id: identifierSchema,
    kind: { enum: ['runtime', 'executable', 'asset'] },
    required: { type: 'boolean' },
    version: nonEmptyStringSchema,
    remediation: nonEmptyStringSchema,
  },
} as const;

const permissionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['network', 'cookies'],
  properties: {
    network: { type: 'boolean' },
    cookies: { type: 'boolean' },
    media: { type: 'boolean' },
  },
} as const;

const manifestProperties = {
  id: identifierSchema,
  name: nonEmptyStringSchema,
  version: { type: 'string', format: 'semver' },
  protocolVersion: nonEmptyStringSchema,
  license: { type: 'string', minLength: 1, format: 'spdx' },
  capabilities: { type: 'array', items: nonEmptyStringSchema },
  priority: { type: 'integer', minimum: -100, maximum: 200 },
  platforms: { type: 'array', items: { enum: platformNames } },
  permissions: permissionsSchema,
  dependencies: { type: 'array', items: dependencySchema },
} as const;

export const pluginManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'name',
    'version',
    'protocolVersion',
    'license',
    'command',
    'capabilities',
    'priority',
    'platforms',
    'permissions',
    'dependencies',
  ],
  properties: {
    schemaVersion: { const: 1 },
    ...manifestProperties,
    command: commandSchema,
  },
} as const;

export const pluginDescriptionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'version',
    'protocolVersion',
    'license',
    'capabilities',
    'priority',
    'platforms',
    'permissions',
    'dependencies',
  ],
  properties: manifestProperties,
} as const;

const requestBaseProperties = {
  protocolVersion: { const: '1' },
  requestId: nonEmptyStringSchema,
} as const;

const emptyPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
} as const;

export const requestEnvelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'operation', 'payload'],
      properties: {
        ...requestBaseProperties,
        operation: { const: 'describe' },
        payload: emptyPayloadSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'operation', 'payload'],
      properties: {
        ...requestBaseProperties,
        operation: { const: 'probe' },
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['input'],
          properties: { input: jsonRecordSchema },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'operation', 'payload'],
      properties: {
        ...requestBaseProperties,
        operation: { const: 'ingest' },
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['input', 'options', 'temporaryDirectory'],
          properties: {
            input: jsonRecordSchema,
            options: jsonRecordSchema,
            temporaryDirectory: nonEmptyStringSchema,
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'operation', 'payload'],
      properties: {
        ...requestBaseProperties,
        operation: { const: 'healthcheck' },
        payload: emptyPayloadSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'operation', 'payload'],
      properties: {
        ...requestBaseProperties,
        operation: { const: 'cancel' },
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['targetRequestId'],
          properties: { targetRequestId: nonEmptyStringSchema },
        },
      },
    },
  ],
} as const;

const protocolErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    details: jsonRecordSchema,
  },
} as const;

export const responseEnvelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'status', 'result'],
      properties: {
        protocolVersion: { const: '1' },
        requestId: nonEmptyStringSchema,
        status: { const: 'success' },
        result: jsonValueRef,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'status', 'error'],
      properties: {
        protocolVersion: { const: '1' },
        requestId: nonEmptyStringSchema,
        status: { const: 'error' },
        error: protocolErrorSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'requestId', 'status', 'error'],
      properties: {
        protocolVersion: { const: '1' },
        requestId: nonEmptyStringSchema,
        status: { const: 'cancelled' },
        error: protocolErrorSchema,
      },
    },
  ],
} as const;

export const probeResultSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['supported', 'confidence', 'reason'],
  properties: {
    supported: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    reason: nonEmptyStringSchema,
  },
} as const;

export const healthcheckResultSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'message'],
        properties: {
          id: identifierSchema,
          severity: { enum: ['info', 'warning', 'error'] },
          message: nonEmptyStringSchema,
          remediation: nonEmptyStringSchema,
        },
      },
    },
  },
} as const;

export const sourceArtifactsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'role', 'path', 'mediaType', 'bytes', 'sha256'],
    properties: {
      id: identifierSchema,
      role: { enum: artifactRoles },
      path: nonEmptyStringSchema,
      mediaType: nonEmptyStringSchema,
      bytes: { type: 'integer', minimum: 0 },
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      metadata: jsonRecordSchema,
    },
  },
} as const;

export const contractFixtureSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['supportedProbe', 'unsupportedProbe', 'ingest'],
  oneOf: [
    {
      type: 'object',
      required: ['cancel'],
      properties: {
        ingest: {
          type: 'object',
          required: ['expectedRoles'],
          properties: { expectedRoles: {} },
        },
        cancel: {},
      },
    },
    {
      type: 'object',
      not: { required: ['cancel'], properties: { cancel: {} } },
      properties: {
        ingest: {
          type: 'object',
          required: ['expectedDiagnosticCode'],
          properties: { expectedDiagnosticCode: {} },
        },
      },
    },
  ],
  properties: {
    supportedProbe: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'minimumConfidence'],
      properties: {
        input: jsonRecordSchema,
        minimumConfidence: { type: 'number', minimum: 0, maximum: 100 },
      },
    },
    unsupportedProbe: {
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: { input: jsonRecordSchema },
    },
    ingest: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'options'],
      oneOf: [
        {
          type: 'object',
          required: ['expectedRoles'],
          not: {
            required: ['expectedDiagnosticCode'],
            properties: { expectedDiagnosticCode: {} },
          },
          properties: { expectedRoles: {}, expectedDiagnosticCode: {} },
        },
        {
          type: 'object',
          required: ['expectedDiagnosticCode'],
          not: { required: ['expectedRoles'], properties: { expectedRoles: {} } },
          properties: { expectedRoles: {}, expectedDiagnosticCode: {} },
        },
      ],
      properties: {
        input: jsonRecordSchema,
        options: jsonRecordSchema,
        expectedRoles: { type: 'array', items: { enum: artifactRoles } },
        expectedDiagnosticCode: nonEmptyStringSchema,
      },
    },
    cancel: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'options'],
      properties: { input: jsonRecordSchema, options: jsonRecordSchema },
    },
  },
} as const;
