# Plugin Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver milestone M1: a schema-first, Windows-first plugin SDK and host that install, discover, select, execute, diagnose, cancel, and contract-test isolated local plugins.

**Architecture:** `@sheldon/plugin-sdk` owns protocol v1, author helpers, JSONL framing, and the reusable contract harness. `@sheldon/plugin-host` owns local installation, discovery, process lifecycle, selection, diagnostics, and artifact validation, while `@sheldon/persistence` stores last-known health and bounded execution summaries. The CLI composes those packages without giving plugins a writable vault path.

**Tech Stack:** Node.js 24+, TypeScript 6 ESM, npm workspaces, SWC, Vitest, Node `child_process`, Node `sqlite`, Ajv 8.20, SemVer 7.8, SPDX expression parser 5.0, YAML.

## Global Constraints

- Keep Node.js `>=24`, TypeScript ESM with `moduleResolution: NodeNext`, SWC builds, and Vitest as the test runner.
- Protocol version is exactly `1`; manifests use schema version `1` and the filename `sheldon-plugin.json`.
- `@sheldon/plugin-sdk` is the public authoring/protocol package; `@sheldon/plugin-host` is private Sheldon infrastructure.
- Start one fresh process for each `describe`, `probe`, `ingest`, or `healthcheck` operation. Only a cooperative `cancel` request may share that process.
- stdin/stdout contain UTF-8 JSONL envelopes only. Human-readable logs use stderr. Large artifacts use a host-created temporary directory.
- Never provide a writable vault path to a plugin. Start commands with `shell: false`.
- Install only from a local directory by staged copy into `%APPDATA%\Sheldon\plugins\<id>`. Do not execute package scripts, download dependencies, or access the network during installation.
- Reject duplicate official or installed plugin IDs. M1 has no `--force` override and no in-place update.
- Official-license allowlist: `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MIT`, `MPL-2.0`.
- Forward only `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`, and locale variables; point `TEMP` and `TMP` to the operation directory.
- Default timeouts: `describe` 10 seconds, `probe` 10 seconds, `healthcheck` 30 seconds, `ingest` 15 minutes, cooperative cancellation 2 seconds.
- Default limits: one JSONL line 1 MiB, total protocol stdout 8 MiB, retained stderr tail 256 KiB, 10,000 artifacts, 2 GiB artifact bytes.
- `plugin-state.db` retains the 10,000 most recent run summaries globally. Health is keyed by plugin ID, version, and manifest digest.
- `plugin list` does not start plugins; it shows discovery and last-known health as separate states and keeps invalid entries visible.
- A confidence-and-priority tie returns ambiguity. Origin never silently breaks a tie.
- Windows process-tree termination is mandatory for M1. Linux and macOS process-tree guarantees remain out of scope.
- Preserve the coverage gate: 80% statements, functions, and lines; 70% branches.
- Every implementation commit that changes public behavior also updates the nearest README and `CHANGELOG.md`; the final documentation task supplies the milestone-wide public updates before `npm run verify`.

---

### Task 1: Protocol v1 schemas and manifest validation

**Files:**

- Create: `packages/plugin-sdk/package.json`
- Create: `packages/plugin-sdk/src/types.ts`
- Create: `packages/plugin-sdk/src/schemas.ts`
- Create: `packages/plugin-sdk/src/errors.ts`
- Create: `packages/plugin-sdk/src/validation.ts`
- Create: `packages/plugin-sdk/src/index.ts`
- Create: `packages/plugin-sdk/test/validation.test.ts`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `scripts/build.mjs`
- Modify: `scripts/build.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: no plugin interfaces; this is the protocol foundation.
- Produces: `PROTOCOL_VERSION`, `PluginManifest`, `PluginDescription`, `ProbeResult`, `HealthcheckResult`, `SourceArtifact`, `RequestEnvelope`, `ResponseEnvelope`, `ContractFixture`, `parsePluginManifest(value, origin)`, `parseRequestEnvelope(value)`, `parseResponseEnvelope(value)`, `parsePluginDescription(value)`, `parseProbeResult(value)`, `parseHealthcheckResult(value)`, `parseSourceArtifacts(value)`, `parseContractFixture(value)`, and `ProtocolValidationError`.

- [ ] **Step 1: Create the workspace manifest and install validation dependencies**

Create `packages/plugin-sdk/package.json`:

```json
{
  "name": "@sheldon/plugin-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "dependencies": {
    "ajv": "^8.20.0",
    "semver": "^7.8.5",
    "spdx-expression-parse": "^5.0.0"
  },
  "devDependencies": {
    "@types/semver": "^7.7.1",
    "@types/spdx-expression-parse": "^4.0.0"
  }
}
```

Run: `npm install`

Expected: npm adds the workspace and validator packages to `package-lock.json` with zero audit vulnerabilities.

- [ ] **Step 2: Write failing protocol-validation tests**

Create `packages/plugin-sdk/test/validation.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest';

import {
  parseContractFixture,
  parsePluginManifest,
  parseRequestEnvelope,
  ProtocolValidationError,
} from '../src/index.js';

const manifest = {
  schemaVersion: 1,
  id: 'example.fixture',
  name: 'Example fixture',
  version: '1.2.3',
  protocolVersion: '1',
  license: 'MIT',
  command: { executable: 'node', arguments: ['plugin.mjs'] },
  capabilities: ['fixture'],
  priority: 10,
  platforms: ['win32'],
  permissions: { network: false, cookies: false },
  dependencies: [
    { id: 'node', kind: 'runtime', required: true, remediation: 'Install Node.js 24.' },
  ],
};

describe('protocol v1 validation', () => {
  it('parses a complete user manifest', () => {
    expect(parsePluginManifest(manifest, 'installed')).toMatchObject({
      id: 'example.fixture',
      origin: 'installed',
      protocolVersion: '1',
    });
  });

  it.each([
    ['bad id', { ...manifest, id: '../escape' }],
    ['bad semver', { ...manifest, version: 'latest' }],
    ['bad SPDX', { ...manifest, license: 'whatever' }],
    ['priority outside range', { ...manifest, priority: 101 }],
    [
      'missing license',
      Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'license')),
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePluginManifest(value, 'installed')).toThrow(ProtocolValidationError);
  });

  it('parses a different protocol version so discovery can report incompatibility', () => {
    expect(parsePluginManifest({ ...manifest, protocolVersion: '2' }, 'installed')).toMatchObject({
      protocolVersion: '2',
    });
  });

  it('rejects an incompatible official license', () => {
    expect(() => parsePluginManifest({ ...manifest, license: 'GPL-3.0-only' }, 'official')).toThrow(
      /official license/i,
    );
  });

  it('parses a protocol request and rejects additional properties', () => {
    expect(
      parseRequestEnvelope({
        protocolVersion: '1',
        requestId: 'request-1',
        operation: 'probe',
        payload: { input: { kind: 'fixture' } },
      }),
    ).toMatchObject({ requestId: 'request-1', operation: 'probe' });
    expect(() =>
      parseRequestEnvelope({
        protocolVersion: '1',
        requestId: 'request-1',
        operation: 'probe',
        payload: {},
        unexpected: true,
      }),
    ).toThrow(ProtocolValidationError);
  });

  it('requires language-neutral contract cases', () => {
    expect(
      parseContractFixture({
        supportedProbe: { input: { kind: 'fixture' }, minimumConfidence: 80 },
        unsupportedProbe: { input: { kind: 'unknown' } },
        ingest: {
          input: { kind: 'fixture' },
          options: {},
          expectedRoles: ['normalized'],
        },
        cancel: { input: { kind: 'fixture', wait: true }, options: {} },
      }),
    ).toMatchObject({ ingest: { expectedRoles: ['normalized'] } });
  });
});
```

- [ ] **Step 3: Run the validation test and observe the red state**

Run: `npx vitest run packages/plugin-sdk/test/validation.test.ts`

Expected: FAIL because `packages/plugin-sdk/src/index.ts` does not exist.

- [ ] **Step 4: Define the protocol types and stable validation error**

Create `packages/plugin-sdk/src/types.ts` with the exact public shapes:

```ts
export const PROTOCOL_VERSION = '1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type PluginOrigin = 'official' | 'installed';
export type PluginOperation = 'describe' | 'probe' | 'ingest' | 'healthcheck' | 'cancel';
export type ArtifactRole = 'original' | 'normalized' | 'asset' | 'inventory' | 'metadata';

export interface PluginCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface PluginDependency {
  readonly id: string;
  readonly kind: 'runtime' | 'executable' | 'asset';
  readonly required: boolean;
  readonly version?: string;
  readonly remediation: string;
}

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly license: string;
  readonly command: PluginCommand;
  readonly capabilities: readonly string[];
  readonly priority: number;
  readonly platforms: readonly NodeJS.Platform[];
  readonly permissions: { readonly network: boolean; readonly cookies: boolean };
  readonly dependencies: readonly PluginDependency[];
  readonly origin: PluginOrigin;
}

export type PluginDescription = Omit<PluginManifest, 'schemaVersion' | 'command' | 'origin'>;

export interface ProbeResult {
  readonly supported: boolean;
  readonly confidence: number;
  readonly reason: string;
}

export interface HealthcheckItem {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly remediation?: string;
}

export interface HealthcheckResult {
  readonly checks: readonly HealthcheckItem[];
}

export interface SourceArtifact {
  readonly id: string;
  readonly role: ArtifactRole;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface IngestRequest {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly temporaryDirectory: string;
}

type RequestBase = {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
};

export type RequestEnvelope =
  | (RequestBase & {
      readonly operation: 'describe';
      readonly payload: Readonly<Record<string, never>>;
    })
  | (RequestBase & {
      readonly operation: 'probe';
      readonly payload: { readonly input: Readonly<Record<string, JsonValue>> };
    })
  | (RequestBase & { readonly operation: 'ingest'; readonly payload: IngestRequest })
  | (RequestBase & {
      readonly operation: 'healthcheck';
      readonly payload: Readonly<Record<string, never>>;
    })
  | (RequestBase & {
      readonly operation: 'cancel';
      readonly payload: { readonly targetRequestId: string };
    });

export interface ProtocolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type ResponseEnvelope<TResult = JsonValue> =
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'success';
      readonly result: TResult;
    }
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'error';
      readonly error: ProtocolErrorBody;
    }
  | {
      readonly protocolVersion: ProtocolVersion;
      readonly requestId: string;
      readonly status: 'cancelled';
      readonly error: ProtocolErrorBody;
    };

export interface ContractFixture {
  readonly supportedProbe: {
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly minimumConfidence: number;
  };
  readonly unsupportedProbe: { readonly input: Readonly<Record<string, JsonValue>> };
  readonly ingest: {
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly options: Readonly<Record<string, JsonValue>>;
    readonly expectedRoles: readonly ArtifactRole[];
  };
  readonly cancel: {
    readonly input: Readonly<Record<string, JsonValue>>;
    readonly options: Readonly<Record<string, JsonValue>>;
  };
}
```

Create `packages/plugin-sdk/src/errors.ts`:

```ts
export class ProtocolValidationError extends Error {
  public constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}
```

- [ ] **Step 5: Define strict JSON Schemas**

Create `packages/plugin-sdk/src/schemas.ts`. Export `pluginManifestSchema`, `requestEnvelopeSchema`, `responseEnvelopeSchema`, and `contractFixtureSchema` as `const` objects. Use JSON Schema draft 2020-12, `additionalProperties: false` on every object, the ID pattern `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`, request IDs with `minLength: 1`, confidence `minimum: 0`/`maximum: 100`, priority `minimum: -100`/`maximum: 100`, bytes as non-negative integers, SHA-256 as `^[a-f0-9]{64}$`, and these operation/status enums:

```ts
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
```

The manifest schema must require every field from `PluginManifest` except host-assigned `origin`; manifest `protocolVersion` is a non-empty string so the host can inventory incompatible versions, while request/response protocol versions are exactly `1`. The request schema must use `oneOf` for the five discriminated payloads from Step 4: empty object for describe/healthcheck, `{ input }` for probe, `{ input, options, temporaryDirectory }` for ingest, and `{ targetRequestId }` for cancel. The response schema must use `oneOf` for success/error/cancelled; and the contract schema must require all four fixture cases shown in Step 2. Also export strict schemas for `PluginDescription`, `ProbeResult`, `HealthcheckResult`, and `SourceArtifact[]` using the exact types and numeric/string limits from Step 4.

- [ ] **Step 6: Compile schemas and implement parsers**

Create `packages/plugin-sdk/src/validation.ts`:

```ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { valid as validSemver } from 'semver';
import parseSpdx from 'spdx-expression-parse';

import { ProtocolValidationError } from './errors.js';
import {
  contractFixtureSchema,
  jsonValueSchema,
  pluginManifestSchema,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  pluginDescriptionSchema,
  probeResultSchema,
  healthcheckResultSchema,
  sourceArtifactsSchema,
} from './schemas.js';
import type {
  ContractFixture,
  HealthcheckResult,
  PluginDescription,
  PluginManifest,
  PluginOrigin,
  ProbeResult,
  RequestEnvelope,
  ResponseEnvelope,
  SourceArtifact,
} from './types.js';

const officialLicenses = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(jsonValueSchema);
ajv.addFormat('semver', (value) => validSemver(value) !== null);
ajv.addFormat('spdx', (value) => {
  try {
    parseSpdx(value);
    return true;
  } catch {
    return false;
  }
});

const validateManifest = ajv.compile(pluginManifestSchema);
const validateRequest = ajv.compile(requestEnvelopeSchema);
const validateResponse = ajv.compile(responseEnvelopeSchema);
const validateContract = ajv.compile(contractFixtureSchema);
const validateDescription = ajv.compile(pluginDescriptionSchema);
const validateProbe = ajv.compile(probeResultSchema);
const validateHealthcheck = ajv.compile(healthcheckResultSchema);
const validateArtifacts = ajv.compile(sourceArtifactsSchema);

function parseWith<T>(validator: ValidateFunction, value: unknown, label: string): T {
  if (validator(value)) return value as T;
  const issues = (validator.errors ?? []).map(formatIssue);
  throw new ProtocolValidationError(`${label} is invalid: ${issues.join('; ')}`, issues);
}

function formatIssue(issue: ErrorObject): string {
  return `${issue.instancePath || '/'} ${issue.message ?? 'is invalid'}`;
}

export function parsePluginManifest(value: unknown, origin: PluginOrigin): PluginManifest {
  const parsed = parseWith<Omit<PluginManifest, 'origin'>>(
    validateManifest,
    value,
    'Plugin manifest',
  );
  if (origin === 'official' && !officialLicenses.has(parsed.license)) {
    throw new ProtocolValidationError(
      `Plugin manifest has incompatible official license: ${parsed.license}`,
      [`/license must be one of ${[...officialLicenses].join(', ')}`],
    );
  }
  return { ...parsed, origin };
}

export const parseRequestEnvelope = (value: unknown): RequestEnvelope =>
  parseWith<RequestEnvelope>(validateRequest, value, 'Protocol request');
export const parseResponseEnvelope = (value: unknown): ResponseEnvelope =>
  parseWith<ResponseEnvelope>(validateResponse, value, 'Protocol response');
export const parsePluginDescription = (value: unknown): PluginDescription =>
  parseWith<PluginDescription>(validateDescription, value, 'Plugin description');
export const parseProbeResult = (value: unknown): ProbeResult =>
  parseWith<ProbeResult>(validateProbe, value, 'Probe result');
export const parseHealthcheckResult = (value: unknown): HealthcheckResult =>
  parseWith<HealthcheckResult>(validateHealthcheck, value, 'Healthcheck result');
export const parseSourceArtifacts = (value: unknown): readonly SourceArtifact[] =>
  parseWith<readonly SourceArtifact[]>(validateArtifacts, value, 'Source artifacts');
export const parseContractFixture = (value: unknown): ContractFixture =>
  parseWith<ContractFixture>(validateContract, value, 'Contract fixture');
```

- [ ] **Step 7: Export the contract and wire the workspace toolchain**

Create `packages/plugin-sdk/src/index.ts`:

```ts
export { ProtocolValidationError } from './errors.js';
export {
  contractFixtureSchema,
  pluginManifestSchema,
  pluginDescriptionSchema,
  probeResultSchema,
  healthcheckResultSchema,
  sourceArtifactsSchema,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
} from './schemas.js';
export {
  parseContractFixture,
  parsePluginManifest,
  parseRequestEnvelope,
  parseResponseEnvelope,
  parsePluginDescription,
  parseProbeResult,
  parseHealthcheckResult,
  parseSourceArtifacts,
} from './validation.js';
export * from './types.js';
```

Add `@sheldon/plugin-sdk` to `tsconfig.json` paths and `vitest.config.ts` aliases. Add `['packages/plugin-sdk/src', 'packages/plugin-sdk/dist']` to `scripts/build.mjs`. Extend `scripts/build.test.ts` to assert `packages/plugin-sdk/dist/index.js` exists and `packages/plugin-sdk/package.json` exports `./dist/index.js`.

- [ ] **Step 8: Run focused and workspace verification**

Run: `npx vitest run packages/plugin-sdk/test/validation.test.ts scripts/build.test.ts`

Expected: 2 test files pass.

Run: `npm run typecheck`

Expected: PASS with no diagnostics.

- [ ] **Step 9: Document and commit the protocol foundation**

Add a README development note that `@sheldon/plugin-sdk` is the schema-first public authoring contract and protocol v1 uses JSONL on stdin/stdout with stderr reserved for logs. Add `Protocol v1 schemas and manifest validation` under `CHANGELOG.md > Unreleased > Added`.

```powershell
git add packages/plugin-sdk package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs scripts/build.test.ts README.md CHANGELOG.md
git commit -m "feat(plugin-sdk): define protocol v1 contracts"
```

### Task 2: TypeScript plugin runtime and JSONL framing

**Files:**

- Create: `packages/plugin-sdk/src/jsonl.ts`
- Create: `packages/plugin-sdk/src/runner.ts`
- Create: `packages/plugin-sdk/test/jsonl.test.ts`
- Create: `packages/plugin-sdk/test/runner.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: protocol types and parsers from Task 1.
- Produces: `JsonlReader`, `writeJsonl(stream, envelope)`, `PluginImplementation`, `PluginExecutionContext`, `definePlugin(implementation)`, and `runPlugin(implementation, options?)`.

- [ ] **Step 1: Write failing JSONL framing tests**

Create `packages/plugin-sdk/test/jsonl.test.ts`:

```ts
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { JsonlReader, writeJsonl } from '../src/jsonl.js';

describe('JSONL framing', () => {
  it('decodes lines split across chunks', async () => {
    const input = new PassThrough();
    const reader = new JsonlReader(input, 128);
    input.write('{"a":');
    input.end('1}\n');
    await expect(reader.next()).resolves.toEqual({ a: 1 });
  });

  it('rejects oversized and malformed lines', async () => {
    const oversized = new PassThrough();
    const oversizedReader = new JsonlReader(oversized, 4);
    oversized.end('{"a":1}\n');
    await expect(oversizedReader.next()).rejects.toThrow(/1 MiB|line limit|exceeds/i);

    const malformed = new PassThrough();
    const malformedReader = new JsonlReader(malformed, 128);
    malformed.end('not-json\n');
    await expect(malformedReader.next()).rejects.toThrow(/JSON/i);
  });

  it('writes one compact envelope and newline', async () => {
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => (text += chunk.toString()));
    await writeJsonl(output, { ok: true });
    expect(text).toBe('{"ok":true}\n');
  });
});
```

- [ ] **Step 2: Run the framing test and observe the red state**

Run: `npx vitest run packages/plugin-sdk/test/jsonl.test.ts`

Expected: FAIL because `jsonl.ts` does not exist.

- [ ] **Step 3: Implement bounded JSONL framing**

Create `packages/plugin-sdk/src/jsonl.ts` with a `StringDecoder`, a byte counter that fails before buffering more than the configured line limit, EOF handling that rejects a non-empty unterminated line, and backpressure-aware writes:

```ts
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export class JsonlReader {
  private readonly iterator;
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';

  public constructor(
    stream: Readable,
    private readonly lineLimitBytes: number,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  public async next(): Promise<unknown | undefined> {
    while (true) {
      const newline = this.buffered.indexOf('\n');
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/, '');
        this.buffered = this.buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > this.lineLimitBytes)
          throw new Error('JSONL line limit exceeded.');
        if (line.length === 0) continue;
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error('Invalid JSONL line.', { cause: error });
        }
      }
      const item = await this.iterator.next();
      if (item.done) {
        this.buffered += this.decoder.end();
        if (this.buffered.length === 0) return undefined;
        throw new Error('JSONL stream ended with an unterminated line.');
      }
      this.buffered += this.decoder.write(item.value as Buffer);
      if (Buffer.byteLength(this.buffered) > this.lineLimitBytes) {
        throw new Error('JSONL line limit exceeded.');
      }
    }
  }
}

export async function writeJsonl(stream: Writable, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (!stream.write(line, 'utf8')) await once(stream, 'drain');
}
```

- [ ] **Step 4: Write failing plugin-runner tests**

Create `packages/plugin-sdk/test/runner.test.ts` using `PassThrough` streams. Cover `describe`, `probe`, `ingest`, `healthcheck`, implementation errors, and cooperative cancel. The cancellation assertion must send an ingest request followed by `{ operation: 'cancel', payload: { targetRequestId: 'ingest-1' } }` and expect both a cancel acknowledgement and a terminal `cancelled` response for `ingest-1`.

Use this implementation fixture:

```ts
const implementation = definePlugin({
  describe: async () => description,
  probe: async ({ input }) => ({
    supported: input.kind === 'fixture',
    confidence: input.kind === 'fixture' ? 90 : 0,
    reason: input.kind === 'fixture' ? 'fixture supported' : 'unsupported input',
  }),
  ingest: async (_request, context) => {
    await new Promise<void>((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), {
        once: true,
      });
    });
    return [];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
});
```

- [ ] **Step 5: Run the runner test and observe the red state**

Run: `npx vitest run packages/plugin-sdk/test/runner.test.ts`

Expected: FAIL because `definePlugin` and `runPlugin` are not exported.

- [ ] **Step 6: Implement the author runtime**

Create `packages/plugin-sdk/src/runner.ts` with these interfaces and behavior:

```ts
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import { JsonlReader, writeJsonl } from './jsonl.js';
import { parseRequestEnvelope } from './validation.js';
import type {
  HealthcheckResult,
  IngestRequest,
  JsonValue,
  PluginDescription,
  ProbeResult,
  RequestEnvelope,
  ResponseEnvelope,
  SourceArtifact,
} from './types.js';

export interface PluginExecutionContext {
  readonly signal: AbortSignal;
  log(message: string): void;
}

export interface PluginImplementation {
  describe(context: PluginExecutionContext): Promise<PluginDescription>;
  probe(
    request: { readonly input: Readonly<Record<string, JsonValue>> },
    context: PluginExecutionContext,
  ): Promise<ProbeResult>;
  ingest(
    request: IngestRequest,
    context: PluginExecutionContext,
  ): Promise<readonly SourceArtifact[]>;
  healthcheck(context: PluginExecutionContext): Promise<HealthcheckResult>;
  cancel(targetRequestId: string): Promise<void>;
}

export interface PluginRunnerOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly error?: Writable;
  readonly lineLimitBytes?: number;
}

export function definePlugin<T extends PluginImplementation>(implementation: T): T {
  return implementation;
}
```

`runPlugin` must parse every request, allow one primary request, create one `AbortController`, dispatch the four primary operations, and keep reading so a cancel request can arrive while the primary promise is pending. Cancel calls `controller.abort(new Error('Plugin operation cancelled.'))`, invokes `implementation.cancel(targetRequestId)`, writes a success acknowledgement for the cancel request, and lets the primary operation produce a `cancelled` terminal envelope. Any implementation exception becomes `PLUGIN_OPERATION_FAILED` unless the signal is aborted. The runner must never write stack traces or logs to stdout; `context.log` writes one line to stderr.

- [ ] **Step 7: Export the runtime and verify the SDK**

Add to `packages/plugin-sdk/src/index.ts`:

```ts
export { JsonlReader, writeJsonl } from './jsonl.js';
export {
  definePlugin,
  runPlugin,
  type PluginExecutionContext,
  type PluginImplementation,
  type PluginRunnerOptions,
} from './runner.js';
```

Run: `npx vitest run packages/plugin-sdk/test/jsonl.test.ts packages/plugin-sdk/test/runner.test.ts`

Expected: both test files pass, including cancellation.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Document and commit the author runtime**

Extend the SDK README section with the minimal `definePlugin`/`runPlugin` shape and the stdout/stderr rule. Add `TypeScript plugin runner with cooperative cancellation` to the existing M1 changelog group.

```powershell
git add packages/plugin-sdk/src packages/plugin-sdk/test README.md CHANGELOG.md
git commit -m "feat(plugin-sdk): run TypeScript plugins over JSONL"
```

### Task 3: Plugin operational-state database

**Files:**

- Create: `packages/persistence/src/plugin-state-db.ts`
- Create: `packages/persistence/test/plugin-state-db.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: Node's built-in `DatabaseSync`; no dependency on plugin packages.
- Produces: `PluginStateDatabase.open(path)`, `recordRun(input)`, `listRuns()`, `saveHealth(input)`, `getHealth(key)`, `deletePluginState(id)`, and `close()`.

- [ ] **Step 1: Write failing persistence tests**

Create `packages/persistence/test/plugin-state-db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { PluginStateDatabase } from '../src/plugin-state-db.js';

describe('PluginStateDatabase', () => {
  it('returns health only for the exact plugin version and manifest digest', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    database.saveHealth({
      pluginId: 'fixture.node',
      version: '1.0.0',
      manifestDigest: 'a'.repeat(64),
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: false,
      checks: [{ id: 'node', severity: 'error', message: 'missing', remediation: 'install' }],
    });
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.0',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ healthy: false });
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.1',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toBeUndefined();
    database.close();
  });

  it('retains only the newest configured number of runs', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 2 });
    for (const index of [1, 2, 3]) {
      database.recordRun({
        pluginId: 'fixture.node',
        version: '1.0.0',
        operation: 'probe',
        startedAt: `2026-07-18T12:00:0${index}.000Z`,
        durationMs: index,
        status: 'success',
        artifactCount: 0,
        artifactBytes: 0,
        stderrTail: '',
      });
    }
    expect(database.listRuns().map((run) => run.durationMs)).toEqual([2, 3]);
    database.close();
  });

  it('deletes health and runs for a removed plugin', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    database.saveHealth({
      pluginId: 'fixture.node',
      version: '1.0.0',
      manifestDigest: 'b'.repeat(64),
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
      checks: [],
    });
    database.deletePluginState('fixture.node');
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.0',
        manifestDigest: 'b'.repeat(64),
      }),
    ).toBeUndefined();
    database.close();
  });
});
```

- [ ] **Step 2: Run the persistence test and observe the red state**

Run: `npx vitest run packages/persistence/test/plugin-state-db.test.ts`

Expected: FAIL because `plugin-state-db.ts` does not exist.

- [ ] **Step 3: Implement the SQLite state store**

Create `packages/persistence/src/plugin-state-db.ts`. Use strict tables and JSON columns:

```sql
CREATE TABLE IF NOT EXISTS plugin_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  operation TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  artifact_count INTEGER NOT NULL,
  artifact_bytes INTEGER NOT NULL,
  stderr_tail TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS plugin_health (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
  checks_json TEXT NOT NULL
) STRICT;
```

Implement typed `PluginRunInput`, `PluginRunRecord`, `PluginHealthInput`, `PluginHealthRecord`, and `PluginHealthKey`. `recordRun` inserts, then deletes rows whose IDs are not among `SELECT id FROM plugin_runs ORDER BY id DESC LIMIT ?`. `saveHealth` uses `INSERT ... ON CONFLICT(plugin_id) DO UPDATE`. `getHealth` queries all three key fields. Parse JSON with an object/array guard and never return mutable database row objects.

- [ ] **Step 4: Export and verify persistence behavior**

Add to `packages/persistence/src/index.ts`:

```ts
export {
  PluginStateDatabase,
  type PluginHealthInput,
  type PluginHealthKey,
  type PluginHealthRecord,
  type PluginRunInput,
  type PluginRunRecord,
} from './plugin-state-db.js';
```

Run: `npx vitest run packages/persistence/test/plugin-state-db.test.ts packages/persistence/test/operations-db.test.ts`

Expected: both persistence test files pass.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Document and commit plugin operational persistence**

Add `plugin-state.db` to the README application-data description and state that it stores rebuildable last-known health plus the 10,000 newest sanitized run summaries. Add the same operator-visible state to the M1 changelog group.

```powershell
git add packages/persistence/src packages/persistence/test README.md CHANGELOG.md
git commit -m "feat(persistence): store plugin health and runs"
```

### Task 4: Atomic local plugin registry

**Files:**

- Create: `packages/plugin-host/package.json`
- Create: `packages/plugin-host/src/app-paths.ts`
- Create: `packages/plugin-host/src/errors.ts`
- Create: `packages/plugin-host/src/manifest-loader.ts`
- Create: `packages/plugin-host/src/registry.ts`
- Create: `packages/plugin-host/src/index.ts`
- Create: `packages/plugin-host/test/registry.test.ts`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `scripts/build.mjs`
- Modify: `scripts/build.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `parsePluginManifest` and `PluginManifest` from Task 1.
- Produces: `pluginAppPaths(appRoot)`, `loadPluginManifest(root, origin)`, `PluginRegistry.open(appRoot)`, `install(sourceDirectory, reservedIds)`, `remove(id)`, `listRecords()`, `PluginInstallationRecord`, `InstalledPlugin`, and `PluginHostError`.

- [ ] **Step 1: Create the host workspace and wire internal dependencies**

Create `packages/plugin-host/package.json`:

```json
{
  "name": "@sheldon/plugin-host",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "dependencies": {
    "@sheldon/persistence": "*",
    "@sheldon/plugin-sdk": "*",
    "yaml": "^2.9.0"
  }
}
```

Run: `npm install`

Expected: npm links both internal workspaces and updates `package-lock.json`.

- [ ] **Step 2: Write failing registry tests**

Create `packages/plugin-host/test/registry.test.ts`. Build source fixtures in temporary directories with a valid `sheldon-plugin.json` and `plugin.mjs`. Assert:

```ts
it('copies a local plugin and records the canonical installation', async () => {
  const registry = await PluginRegistry.open(appRoot);
  const installed = await registry.install(sourceRoot, new Set());
  expect(installed.root).toBe(join(appRoot, 'plugins', 'fixture.node'));
  expect(await readFile(join(installed.root, 'plugin.mjs'), 'utf8')).toBe('plugin source');
  expect(registry.listRecords()).toEqual([
    expect.objectContaining({
      id: 'fixture.node',
      version: '1.0.0',
      root: join(appRoot, 'plugins', 'fixture.node'),
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  ]);
});

it('rejects installed and official identifier collisions without changing files', async () => {
  const registry = await PluginRegistry.open(appRoot);
  await expect(registry.install(sourceRoot, new Set(['fixture.node']))).rejects.toMatchObject({
    code: 'PLUGIN_ID_COLLISION',
  });
  await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
});

it('rejects a link that escapes the source tree', async () => {
  await symlink(outsideFile, join(sourceRoot, 'escape.txt'));
  const registry = await PluginRegistry.open(appRoot);
  await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
    code: 'PLUGIN_SOURCE_ESCAPE',
  });
});

it('removes only the exact registered child and leaves arbitrary directories untouched', async () => {
  const registry = await PluginRegistry.open(appRoot);
  await registry.install(sourceRoot, new Set());
  const unrelated = join(appRoot, 'keep');
  await mkdir(unrelated);
  await registry.remove('fixture.node');
  await expect(access(unrelated)).resolves.toBeUndefined();
  await expect(registry.remove('../keep')).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
});
```

Also inject a registry writer that throws before replacement and verify the staged/final directory is rolled back and the old YAML remains byte-for-byte unchanged.

- [ ] **Step 3: Run registry tests and observe the red state**

Run: `npx vitest run packages/plugin-host/test/registry.test.ts`

Expected: FAIL because `PluginRegistry` does not exist.

- [ ] **Step 4: Implement app paths, host errors, and manifest loading**

Create `packages/plugin-host/src/app-paths.ts`:

```ts
import { join } from 'node:path';

export interface PluginAppPaths {
  readonly root: string;
  readonly plugins: string;
  readonly registry: string;
  readonly stateDatabase: string;
}

export function pluginAppPaths(appRoot: string): PluginAppPaths {
  return {
    root: appRoot,
    plugins: join(appRoot, 'plugins'),
    registry: join(appRoot, 'plugin-registry.yaml'),
    stateDatabase: join(appRoot, 'plugin-state.db'),
  };
}
```

Create `PluginHostError` in `errors.ts` with `code`, `target`, and `recovery` properties. Create `manifest-loader.ts` that reads exactly `<root>/sheldon-plugin.json`, parses JSON, calls `parsePluginManifest`, computes the SHA-256 digest of the original bytes, and returns:

```ts
export interface LoadedPluginManifest {
  readonly manifest: PluginManifest;
  readonly manifestDigest: string;
  readonly root: string;
}
```

Map missing files, JSON parse errors, and protocol validation errors to stable host codes `PLUGIN_MANIFEST_MISSING`, `PLUGIN_MANIFEST_JSON_INVALID`, and `PLUGIN_MANIFEST_INVALID`.

- [ ] **Step 5: Implement safe staged copying**

In `registry.ts`, preflight the source tree using `lstat`, `realpath`, and `readdir`. For every symlink or junction, resolve its target and reject when `relative(canonicalSource, canonicalTarget)` is absolute or begins with `..`. Track visited canonical directories to reject cycles. Copy with `cp(source, stage, { recursive: true, dereference: true, errorOnExist: true, force: false })` only after preflight succeeds.

Use this path guard for install and removal:

```ts
function assertExactPluginChild(pluginsRoot: string, id: string, candidate: string): string {
  const expected = resolve(pluginsRoot, id);
  if (resolve(candidate) !== expected || dirname(expected) !== resolve(pluginsRoot)) {
    throw new PluginHostError(
      'PLUGIN_PATH_UNSAFE',
      `Unsafe plugin path for ${id}.`,
      candidate,
      'Repair plugin-registry.yaml before retrying.',
    );
  }
  return expected;
}
```

- [ ] **Step 6: Implement atomic YAML registry updates**

Persist this versioned shape:

```ts
interface RegistryDocument {
  readonly version: 1;
  readonly plugins: readonly PluginInstallationRecord[];
}

export interface PluginInstallationRecord {
  readonly id: string;
  readonly version: string;
  readonly root: string;
  readonly manifestDigest: string;
  readonly installedAt: string;
}
```

`PluginRegistry.open` creates the application and plugin directories, reads an absent registry as `{ version: 1, plugins: [] }`, rejects unsupported registry versions, and keeps records in ID order. Write YAML to a unique sibling file with mode `0o600`, fsync/close it, then rename over the registry. Install ordering is: load source manifest as `installed`; reject IDs in `reservedIds` or existing records; preflight; copy to unique stage; reload the staged manifest and require the same ID/digest; rename stage to the exact final child; atomically persist the record; remove the final child if registry persistence fails. Always remove remaining stage directories in `finally`.

Removal resolves only an existing record, applies `assertExactPluginChild`, removes that directory, then atomically writes the registry without the record. If registry writing fails after deletion, throw `PLUGIN_REGISTRY_WRITE_FAILED` with recovery text that tells the operator to reinstall; never delete another path to compensate.

- [ ] **Step 7: Export, wire, and verify the host package**

Export the Task 4 public interfaces from `packages/plugin-host/src/index.ts`. Add `@sheldon/plugin-host` to TypeScript paths and Vitest aliases, add the package to SWC build targets, and extend `scripts/build.test.ts` with its dist entry point and package export assertion.

Run: `npx vitest run packages/plugin-host/test/registry.test.ts scripts/build.test.ts`

Expected: both test files pass.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Document and commit atomic plugin installation**

Document `%APPDATA%\Sheldon\plugins\<id>`, staged local-directory copy, duplicate-ID rejection, and the no-script/no-download install boundary in README. Add atomic install/remove to the M1 changelog group.

```powershell
git add packages/plugin-host package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs scripts/build.test.ts README.md CHANGELOG.md
git commit -m "feat(plugin-host): install local plugins atomically"
```

### Task 5: Bounded ephemeral process runner

**Files:**

- Create: `packages/plugin-host/src/limits.ts`
- Create: `packages/plugin-host/src/stderr-tail.ts`
- Create: `packages/plugin-host/src/process-runner.ts`
- Create: `packages/plugin-host/test/process-runner.test.ts`
- Create: `packages/plugin-host/test/fixtures/protocol-fixture.mjs`
- Modify: `packages/plugin-host/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `LoadedPluginManifest`, protocol envelope/result validators, `JsonlReader`, `writeJsonl`, and `PluginStateDatabase.recordRun`.
- Produces: `DEFAULT_PLUGIN_LIMITS`, `PluginLimits`, `RunnablePlugin`, `PluginProcessRunner.describe`, `probe`, and `healthcheck`; Task 6 adds ingest/cancellation.

- [ ] **Step 1: Write failing successful-process and environment tests**

Create `packages/plugin-host/test/fixtures/protocol-fixture.mjs`. It reads one JSON line from stdin and switches on `operation`. For `describe`, return a hard-coded description that exactly matches the fixture manifest. For `probe`, return `{ supported: true, confidence: 90, reason: JSON.stringify({ secret: process.env.SHELDON_TEST_SECRET ?? null, path: process.env.PATH ?? null, temp: process.env.TEMP ?? null, tmp: process.env.TMP ?? null }) }`. For `healthcheck`, write `fixture log\n` to stderr and return `{ checks: [] }`. Every response uses the incoming request ID and protocol version.

Create `packages/plugin-host/test/process-runner.test.ts` with a temporary plugin root and manifest whose command is `{ executable: process.execPath, arguments: [fixturePath] }`:

```ts
it('runs a fresh process, sanitizes its environment, and retains stderr separately', async () => {
  const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
  const runner = new PluginProcessRunner({
    state,
    environment: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SHELDON_TEST_SECRET: 'must-not-leak',
    },
  });
  const probe = await runner.probe(plugin, { kind: 'fixture' });
  const environment = JSON.parse(probe.result.reason);
  expect(environment).toMatchObject({ secret: null });
  expect(environment.path).toBe(process.env.PATH);
  expect(environment.temp).toBe(environment.tmp);
  expect(environment.temp).not.toBe(process.env.TEMP);

  const health = await runner.healthcheck(plugin);
  expect(health.stderrTail).toBe('fixture log\n');
  expect(state.listRuns()).toHaveLength(2);
  state.close();
});
```

The fixture must serialize missing environment values as `null`, not omit them.

- [ ] **Step 2: Write failing protocol-violation and limit tests**

Add fixture modes selected by the first static command argument: `malformed` writes `not-json\n`; `duplicate` writes two terminal envelopes; `late-output` writes a terminal envelope then `extra\n`; `oversized-line` writes more than the configured line limit; `oversized-total` writes one otherwise valid terminal result larger than an injected total-output limit but smaller than its injected line limit; `wrong-request` returns another request ID; `nonzero` exits 9 without a terminal response.

Add table-driven tests asserting the codes:

```ts
it.each([
  ['malformed', 'PLUGIN_PROTOCOL_INVALID_JSON'],
  ['duplicate', 'PLUGIN_PROTOCOL_DUPLICATE_TERMINAL'],
  ['late-output', 'PLUGIN_PROTOCOL_LATE_OUTPUT'],
  ['oversized-line', 'PLUGIN_PROTOCOL_LINE_LIMIT'],
  ['oversized-total', 'PLUGIN_PROTOCOL_OUTPUT_LIMIT'],
  ['wrong-request', 'PLUGIN_PROTOCOL_REQUEST_MISMATCH'],
  ['nonzero', 'PLUGIN_PROCESS_EXITED'],
])('fails %s without exposing a successful result', async (mode, code) => {
  await expect(runner.describe(pluginFor(mode))).rejects.toMatchObject({ code });
  expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', errorCode: code });
});
```

- [ ] **Step 3: Run process tests and observe the red state**

Run: `npx vitest run packages/plugin-host/test/process-runner.test.ts`

Expected: FAIL because `PluginProcessRunner` does not exist.

- [ ] **Step 4: Implement defaults and a bounded stderr tail**

Create `limits.ts`:

```ts
export interface PluginLimits {
  readonly timeouts: {
    readonly describe: number;
    readonly probe: number;
    readonly healthcheck: number;
    readonly ingest: number;
    readonly cancellationGrace: number;
  };
  readonly lineBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly artifactCount: number;
  readonly artifactBytes: number;
}

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = {
  timeouts: {
    describe: 10_000,
    probe: 10_000,
    healthcheck: 30_000,
    ingest: 15 * 60_000,
    cancellationGrace: 2_000,
  },
  lineBytes: 1024 * 1024,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 256 * 1024,
  artifactCount: 10_000,
  artifactBytes: 2 * 1024 * 1024 * 1024,
};
```

Create `StderrTail` that consumes buffers, keeps only the newest configured number of bytes, decodes UTF-8 safely at the end, and exposes `text()`.

- [ ] **Step 5: Implement sanitized process spawning and terminal validation**

Create `process-runner.ts` with:

```ts
export interface RunnablePlugin extends LoadedPluginManifest {}

export interface ProcessOperationResult<T> {
  readonly result: T;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface PluginProcessRunnerOptions {
  readonly state: PluginStateDatabase;
  readonly environment?: NodeJS.ProcessEnv;
  readonly limits?: PluginLimits;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}
```

Build a child environment from the exact allowlist in Global Constraints; copy locale keys matching `LANG`, `LANGUAGE`, and `LC_*`; override `TEMP` and `TMP` with the operation directory. Spawn with `cwd: plugin.root`, `shell: false`, `windowsHide: true`, and piped stdin/stdout/stderr. Count raw stdout bytes before JSON decoding. Parse each line with `parseResponseEnvelope`, require the current request ID, accept exactly one terminal response, keep reading until process exit to detect late output, and require exit code 0 after a terminal success.

Map framing and lifecycle failures to the stable codes asserted in Step 2. Operation-specific methods must validate results using `parsePluginDescription`, `parseProbeResult`, and `parseHealthcheckResult`. `describe` additionally requires ID, version, protocol, license, permissions, and capabilities to equal the manifest.

Record one run in `finally`, including operation, timestamps, duration, status, exit code, zero artifact counts for these operations, bounded stderr, and sanitized code/message. Never include request payloads or environment values in the record.

- [ ] **Step 6: Verify process behavior and regressions**

Run: `npx vitest run packages/plugin-host/test/process-runner.test.ts packages/plugin-sdk/test`

Expected: all SDK and process-runner tests pass.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Document and commit bounded process execution**

Document ephemeral processes, sanitized environment, operation defaults, output limits, and bounded stderr in README. Add bounded process execution to the M1 changelog group.

```powershell
git add packages/plugin-host/src packages/plugin-host/test README.md CHANGELOG.md
git commit -m "feat(plugin-host): run bounded plugin processes"
```

### Task 6: Artifact validation, timeout, cancellation, and process-tree cleanup

**Files:**

- Create: `packages/plugin-host/src/artifact-validator.ts`
- Create: `packages/plugin-host/src/process-tree.ts`
- Create: `packages/plugin-host/test/artifact-validator.test.ts`
- Create: `packages/plugin-host/test/process-lifecycle.test.ts`
- Create: `packages/plugin-host/test/fixtures/slow-tree.mjs`
- Modify: `packages/plugin-host/src/process-runner.ts`
- Modify: `packages/plugin-host/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: Task 5 process runner and Task 1 `SourceArtifact` validation.
- Produces: `ArtifactValidator.validate(root, descriptors, limits)`, `terminateProcessTree(child)`, and `PluginProcessRunner.ingest(plugin, input, options, consume, runOptions?)`.

- [ ] **Step 1: Write failing artifact-validation tests**

Create `packages/plugin-host/test/artifact-validator.test.ts`. Write `content.md` below a temporary root and verify the happy path using its real byte length and SHA-256. Add table-driven failures for absolute paths, `../` traversal, duplicate normalized paths, missing files, directories, byte mismatch, digest mismatch, too many artifacts, total bytes over the limit, and a symlink/junction whose real path escapes the root. Assert stable codes such as `PLUGIN_ARTIFACT_PATH_ESCAPE`, `PLUGIN_ARTIFACT_MISSING`, `PLUGIN_ARTIFACT_DIGEST_MISMATCH`, and `PLUGIN_ARTIFACT_LIMIT`.

Use this happy-path assertion:

```ts
await expect(
  validator.validate(
    root,
    [
      {
        id: 'content',
        role: 'normalized',
        path: 'content.md',
        mediaType: 'text/markdown',
        bytes: Buffer.byteLength('# Fixture\n'),
        sha256: createHash('sha256').update('# Fixture\n').digest('hex'),
      },
    ],
    limits,
  ),
).resolves.toEqual([expect.objectContaining({ id: 'content', path: 'content.md' })]);
```

- [ ] **Step 2: Run artifact tests and observe the red state**

Run: `npx vitest run packages/plugin-host/test/artifact-validator.test.ts`

Expected: FAIL because `ArtifactValidator` does not exist.

- [ ] **Step 3: Implement containment, hash, and aggregate validation**

Create `artifact-validator.ts`. Resolve the canonical temporary root once. For each descriptor: reject `isAbsolute(path)` and any normalized path whose first segment is `..`; reject duplicates case-insensitively on Windows; call `realpath` and require the result to remain beneath the canonical root; require `lstat(realPath).isFile()`; stream SHA-256 with `createReadStream`; compare actual bytes/digest; and update aggregate count/bytes before returning a frozen copy of all descriptors. Stop immediately when count or byte limits are exceeded.

- [ ] **Step 4: Write failing cooperative-cancel and timeout-tree tests**

Extend `protocol-fixture.mjs` with `cooperative-cancel`: start ingest, keep reading, respond success to a matching cancel request, remove any partial artifact, and emit a terminal `cancelled` response for the primary request.

Create `slow-tree.mjs`: on ingest, spawn `process.execPath` with `setInterval(() => {}, 1_000)` as a descendant, write `descendant-pid:<pid>\n` to stderr, ignore cancel, and keep the parent alive.

Create `process-lifecycle.test.ts`:

```ts
it('cancels cooperatively and removes partial artifacts', async () => {
  const controller = new AbortController();
  const operation = runner.ingest(
    cooperativePlugin,
    { kind: 'fixture' },
    {},
    async () => 'must not run',
    { signal: controller.signal },
  );
  controller.abort(new Error('user cancelled'));
  await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
  expect(state.listRuns().at(-1)).toMatchObject({ status: 'cancelled' });
  expect(await operationDirectories()).toEqual([]);
});

it.skipIf(process.platform !== 'win32')(
  'kills a timed-out process and its descendant',
  async () => {
    await expect(
      runner.ingest(slowTreePlugin, { kind: 'fixture' }, {}, async () => undefined),
    ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
    const stderr = state.listRuns().at(-1)?.stderrTail ?? '';
    const descendantPid = Number(/descendant-pid:(\d+)/.exec(stderr)?.[1]);
    await expect
      .poll(() => {
        try {
          process.kill(descendantPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(await operationDirectories()).toEqual([]);
  },
);
```

Inject a 100 ms ingest timeout and 50 ms cancellation grace in this test.

- [ ] **Step 5: Run lifecycle tests and observe the red state**

Run: `npx vitest run packages/plugin-host/test/process-lifecycle.test.ts`

Expected: FAIL because ingest cancellation and tree termination are not implemented.

- [ ] **Step 6: Implement non-shell process-tree termination**

Create `process-tree.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', reject);
      killer.once('exit', (code) =>
        code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited ${code}`)),
      );
    });
    return;
  }
  child.kill('SIGKILL');
}
```

The host must await the plugin child's `exit`/`close` event after the termination command. Do not use a shell command string.

- [ ] **Step 7: Add timeout, AbortSignal, cooperative cancel, and ingest lease**

Modify `PluginProcessRunner` so every primary operation races its configured timeout. On caller abort, send a cancel envelope with a new request ID and `{ targetRequestId }`, wait for its acknowledgement and the primary cancelled response until `cancellationGrace`, then call `terminateProcessTree`. Timeout follows the same tree-kill path but reports `PLUGIN_TIMEOUT`; caller abort reports `PLUGIN_CANCELLED`.

Implement ingest with a consumer callback so temporary files cannot outlive their validated lease:

```ts
public async ingest<T>(
  plugin: RunnablePlugin,
  input: Readonly<Record<string, JsonValue>>,
  options: Readonly<Record<string, JsonValue>>,
  consume: (lease: {
    readonly temporaryDirectory: string;
    readonly artifacts: readonly SourceArtifact[];
  }) => Promise<T>,
  runOptions: { readonly signal?: AbortSignal } = {},
): Promise<T>
```

The runner creates the directory, sends it in `IngestRequest`, validates the returned descriptor array and files, calls `consume` only after complete validation, records artifact count/bytes, and removes the directory in `finally` after the consumer settles. A timeout, cancellation, protocol error, validation error, or consumer error returns no successful artifact result and still cleans up.

- [ ] **Step 8: Verify lifecycle, artifact safety, and existing process behavior**

Run: `npx vitest run packages/plugin-host/test/artifact-validator.test.ts packages/plugin-host/test/process-lifecycle.test.ts packages/plugin-host/test/process-runner.test.ts`

Expected: all three files pass; on Windows the descendant-kill test runs rather than skips.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Document and commit lifecycle safety**

Document temporary artifact descriptors, validation-before-consumption, cooperative cancellation, forced Windows tree termination, and the explicit non-sandbox warning in README. Add cancellation/timeout/artifact safety to the M1 changelog group.

```powershell
git add packages/plugin-host/src packages/plugin-host/test README.md CHANGELOG.md
git commit -m "feat(plugin-host): cancel plugin process trees safely"
```

### Task 7: Discovery, selection, and doctor services

**Files:**

- Create: `packages/plugin-host/src/discovery.ts`
- Create: `packages/plugin-host/src/selector.ts`
- Create: `packages/plugin-host/src/doctor.ts`
- Create: `packages/plugin-host/test/discovery.test.ts`
- Create: `packages/plugin-host/test/selector.test.ts`
- Create: `packages/plugin-host/test/doctor.test.ts`
- Modify: `packages/plugin-host/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: Task 4 registry/manifest loader, Task 5 runner, and Task 3 health store.
- Produces: `PluginDiscovery.discover()`, `PluginInventoryEntry`, `PluginSelector.select(entries, input, options?)`, `PluginSelection`, `PluginAmbiguity`, and `PluginDoctor.check(entry)`.

- [ ] **Step 1: Write failing discovery and cached-health tests**

Create `discovery.test.ts` with official roots, installed registry entries, and a `PluginStateDatabase`. Assert that discovery:

```ts
expect(await discovery.discover()).toEqual([
  expect.objectContaining({
    id: 'fixture.invalid',
    origin: 'official',
    discovery: { status: 'invalid', reason: expect.stringContaining('manifest') },
    health: { status: 'unchecked' },
  }),
  expect.objectContaining({
    id: 'fixture.linux',
    discovery: { status: 'incompatible', reason: expect.stringContaining('win32') },
  }),
  expect.objectContaining({
    id: 'fixture.node',
    discovery: { status: 'ready' },
    health: {
      status: 'unhealthy',
      checkedAt: '2026-07-18T12:00:00.000Z',
      stale: false,
    },
  }),
]);
```

Add cases for protocol version `2`, an official/installed collision created by registry tampering, and a health row whose manifest digest differs. Protocol/platform mismatches must be `incompatible`, collisions must mark every colliding entry `collision`, invalid manifests must remain visible using their directory or registry ID, and digest/version mismatches must produce `unchecked` rather than stale `healthy`.

- [ ] **Step 2: Run discovery tests and observe the red state**

Run: `npx vitest run packages/plugin-host/test/discovery.test.ts`

Expected: FAIL because `PluginDiscovery` does not exist.

- [ ] **Step 3: Implement inventory discovery without process execution**

Create these public shapes:

```ts
export type DiscoveryState =
  | { readonly status: 'ready' }
  | { readonly status: 'invalid' | 'incompatible' | 'collision'; readonly reason: string };

export type LastHealthState =
  | { readonly status: 'unchecked' }
  | {
      readonly status: 'healthy' | 'unhealthy';
      readonly checkedAt: string;
      readonly stale: false;
      readonly checks: readonly HealthcheckItem[];
    };

export interface PluginInventoryEntry {
  readonly id: string;
  readonly origin: PluginOrigin;
  readonly root: string;
  readonly manifest?: PluginManifest;
  readonly manifestDigest?: string;
  readonly discovery: DiscoveryState;
  readonly health: LastHealthState;
}
```

`PluginDiscovery` receives `officialRoots`, a registry, state database, and `platform` (default `process.platform`). It reads manifests only; it never starts a plugin. A parsed manifest is incompatible when `protocolVersion !== '1'` or `platforms` does not include the current platform. Apply collision status after collecting all roots. Load cached health only for ready entries and only through the exact ID/version/digest key.

- [ ] **Step 4: Write failing selection tests**

Create `selector.test.ts` with a fake runner whose `probe` results are keyed by ID. Cover capability filtering, unsupported results, explicit override, confidence ordering, priority as secondary ordering, and exact ties:

```ts
await expect(selector.select(entries, { kind: 'fixture' })).resolves.toEqual({
  status: 'ambiguous',
  candidates: [
    { id: 'fixture.a', confidence: 90, priority: 10, reason: 'a' },
    { id: 'fixture.b', confidence: 90, priority: 10, reason: 'b' },
  ],
});
```

Assert origin does not affect ordering and an explicit incompatible/unsupported ID fails with `PLUGIN_OVERRIDE_INVALID`/`PLUGIN_OVERRIDE_UNSUPPORTED`.

- [ ] **Step 5: Implement deterministic selection**

Implement `PluginSelector.select(entries, input, { capability, pluginId, signal }?)`. Consider only ready entries with manifests and the requested capability. Probe candidates in stable ID order, retain supported results, sort by confidence descending, priority descending, then ID only for deterministic presentation. Return:

```ts
export type PluginSelection =
  | { readonly status: 'selected'; readonly plugin: RunnablePlugin; readonly probe: ProbeResult }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly {
        readonly id: string;
        readonly confidence: number;
        readonly priority: number;
        readonly reason: string;
      }[];
    };
```

If no plugin supports the input, throw `PLUGIN_NOT_SUPPORTED`. Do not use origin or discovery order to choose among equal confidence/priority candidates.

- [ ] **Step 6: Write failing doctor tests**

Create `doctor.test.ts`. With a fake runner, assert a ready plugin executes only `healthcheck`, treats `error` checks as unhealthy while warnings remain healthy, persists the result, and returns every remediation. Assert invalid and incompatible entries return a diagnostic without calling the runner. Assert the saved key includes exact ID, version, and manifest digest.

- [ ] **Step 7: Implement doctor and health persistence**

Implement:

```ts
export interface PluginDoctorResult {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly healthy: boolean;
  readonly checks: readonly HealthcheckItem[];
  readonly executed: boolean;
}
```

`PluginDoctor.check(entry)` returns one synthetic error check for invalid/incompatible/collision entries and `executed: false`. For ready entries, call only `runner.healthcheck`, set healthy when no check has severity `error`, persist through `saveHealth`, and return `executed: true`. Use an injected clock for deterministic tests.

- [ ] **Step 8: Export and verify inventory services**

Export all Task 7 interfaces from `packages/plugin-host/src/index.ts`.

Run: `npx vitest run packages/plugin-host/test/discovery.test.ts packages/plugin-host/test/selector.test.ts packages/plugin-host/test/doctor.test.ts`

Expected: all three files pass.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Document and commit discovery and diagnostics**

Document discovery states (`ready`, `invalid`, `incompatible`, `collision`), last-health states (`healthy`, `unhealthy`, `unchecked`), explicit tie behavior, and doctor remediations in README. Add discovery/selection/doctor to the M1 changelog group.

```powershell
git add packages/plugin-host/src packages/plugin-host/test README.md CHANGELOG.md
git commit -m "feat(plugin-host): discover and diagnose plugins"
```

### Task 8: Reusable language-neutral contract harness

**Files:**

- Create: `packages/plugin-sdk/src/contract-client.ts`
- Create: `packages/plugin-sdk/src/contract.ts`
- Create: `packages/plugin-sdk/test/contract.test.ts`
- Create: `packages/plugin-sdk/test/fixtures/raw/sheldon-plugin.json`
- Create: `packages/plugin-sdk/test/fixtures/raw/sheldon-plugin.contract.json`
- Create: `packages/plugin-sdk/test/fixtures/raw/plugin.mjs`
- Create: `test-fixtures/plugins/node-sdk/sheldon-plugin.json`
- Create: `test-fixtures/plugins/node-sdk/sheldon-plugin.contract.json`
- Create: `test-fixtures/plugins/node-sdk/plugin.mjs`
- Create: `test-fixtures/plugins/powershell/sheldon-plugin.json`
- Create: `test-fixtures/plugins/powershell/sheldon-plugin.contract.json`
- Create: `test-fixtures/plugins/powershell/plugin.ps1`
- Create: `scripts/verify-plugin-contract.mjs`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: Task 1 schemas, Task 2 framing/runtime, and the Task 6 artifact rules.
- Produces: `runPluginContract(pluginRoot, options?)`, `PluginContractReport`, and the two milestone fixture plugins.

- [ ] **Step 1: Write a failing process-contract test**

Create the three files under `packages/plugin-sdk/test/fixtures/raw/`. The manifest runs `node plugin.mjs`; the contract file contains supported, unsupported, ingest, and cancellation cases; `plugin.mjs` is a raw JSONL process that implements describe, supported/unsupported probe, healthcheck with stderr logs, ingest that writes `content.md`, and active-operation cancel.

Create `packages/plugin-sdk/test/contract.test.ts`:

```ts
it('runs the complete contract against a process that imports no SDK code', async () => {
  const report = await runPluginContract(fixtureRoot, {
    timeoutMs: 2_000,
  });
  expect(report).toEqual({
    pluginId: 'fixture.raw',
    passed: true,
    checks: [
      expect.objectContaining({ operation: 'describe', passed: true }),
      expect.objectContaining({ operation: 'probe-supported', passed: true }),
      expect.objectContaining({ operation: 'probe-unsupported', passed: true }),
      expect.objectContaining({ operation: 'healthcheck', passed: true }),
      expect.objectContaining({ operation: 'ingest', passed: true }),
      expect.objectContaining({ operation: 'cancel', passed: true }),
      expect.objectContaining({ operation: 'stderr', passed: true }),
    ],
  });
});
```

Add a malformed fixture response case and require a failed report with the failing check rather than an unstructured exception.

- [ ] **Step 2: Run the contract test and observe the red state**

Run: `npx vitest run packages/plugin-sdk/test/contract.test.ts`

Expected: FAIL because `runPluginContract` does not exist.

- [ ] **Step 3: Implement the standalone contract client**

Create `contract-client.ts` with a small process client dedicated to development verification. It must use `shell: false`, Task 2 JSONL framing, a fixed per-operation timeout, protocol/result validators, and a temporary directory for ingest. It may inherit the developer's environment because it is an explicit test command, but it must not receive a vault path. Keep this client separate from production `plugin-host` lifecycle code.

Expose:

```ts
export interface ContractCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
}

export class ContractClient {
  public request<T>(
    command: ContractCommand,
    operation: PluginOperation,
    payload: JsonValue,
  ): Promise<{
    readonly result: T;
    readonly stderr: string;
  }>;
  public cancelActive(command: ContractCommand, ingestPayload: JsonValue): Promise<void>;
}
```

`cancelActive` starts ingest, sends cancel for the active request, and requires a cancel acknowledgement plus a terminal cancelled response.

- [ ] **Step 4: Implement the contract harness and structured report**

Create `contract.ts`:

```ts
export interface PluginContractCheck {
  readonly operation:
    | 'describe'
    | 'probe-supported'
    | 'probe-unsupported'
    | 'healthcheck'
    | 'ingest'
    | 'cancel'
    | 'stderr';
  readonly passed: boolean;
  readonly message: string;
}

export interface PluginContractReport {
  readonly pluginId: string;
  readonly passed: boolean;
  readonly checks: readonly PluginContractCheck[];
}
```

`runPluginContract` reads and validates `sheldon-plugin.json` and `sheldon-plugin.contract.json`; resolves relative executables/arguments without a shell; runs describe and requires manifest identity agreement; runs both probe cases and confidence expectations; runs healthcheck and validates every check; runs ingest, validates file paths/hashes/bytes and expected roles; runs the cancellation case; and records that stderr logs coexist with successful healthcheck. Catch each case independently so the final report names every failed check.

- [ ] **Step 5: Create the Node SDK fixture**

Create a valid manifest for ID `fixture.node-sdk`, command `node plugin.mjs`, MIT license, win32 platform, fixture capability, and no network/cookies. Create the contract file with supported `{ "kind": "fixture" }`, unsupported `{ "kind": "unknown" }`, ingest `{ "kind": "fixture" }`, expected role `normalized`, and cancellation `{ "kind": "fixture", "wait": true }`.

Create `plugin.mjs` importing `definePlugin` and `runPlugin` from `@sheldon/plugin-sdk`. Its ingest writes `# Node SDK fixture\n` to `content.md`, returns exact SHA-256/bytes, and waits for abort when `input.wait === true`. Its healthcheck writes a line through `context.log` and returns one info check.

- [ ] **Step 6: Create the raw PowerShell fixture**

Create a valid manifest for ID `fixture.powershell`, command `powershell.exe -NoProfile -ExecutionPolicy Bypass -File plugin.ps1`, MIT license, win32 platform, and the same contract cases. `plugin.ps1` must read stdin with `[Console]::In.ReadLine()`, parse with `ConvertFrom-Json`, write compact JSON only through `[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 20))`, and log only through `[Console]::Error.WriteLine(...)`. For waiting ingest, retain the primary request ID, read the cancel request, acknowledge it, delete partial output, and return primary status `cancelled`.

- [ ] **Step 7: Add post-build acceptance verification for both fixtures**

Create `scripts/verify-plugin-contract.mjs`:

```js
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { runPluginContract } from '../packages/plugin-sdk/dist/index.js';

for (const fixture of ['node-sdk', 'powershell']) {
  const report = await runPluginContract(resolve('test-fixtures', 'plugins', fixture));
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  process.stdout.write(`${report.pluginId}: contract passed\n`);
}
```

Export contract APIs from `packages/plugin-sdk/src/index.ts`.

- [ ] **Step 8: Verify unit and cross-language contracts**

Run: `npx vitest run packages/plugin-sdk/test/contract.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS and emit plugin SDK/host dist files.

Run: `node scripts/verify-plugin-contract.mjs`

Expected:

```text
fixture.node-sdk: contract passed
fixture.powershell: contract passed
```

- [ ] **Step 9: Document and commit the reusable contract suite**

Document `sheldon-plugin.contract.json`, the imported TypeScript harness, and the post-build Node SDK/PowerShell evidence command in README. Add the language-neutral contract suite to the M1 changelog group.

```powershell
git add packages/plugin-sdk/src packages/plugin-sdk/test test-fixtures/plugins scripts/verify-plugin-contract.mjs README.md CHANGELOG.md
git commit -m "test(plugin-sdk): add reusable plugin contracts"
```

### Task 9: Plugin CLI commands

**Files:**

- Create: `apps/cli/src/commands/plugins.ts`
- Create: `apps/cli/test/plugins.test.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/runtime.ts`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: all host services from Tasks 4–7 and `runPluginContract` from Task 8.
- Produces: `sheldon plugin install|remove|list|doctor|test` and `appDataRoot(context)`.

- [ ] **Step 1: Add CLI workspace dependencies**

Add to `apps/cli/package.json` dependencies:

```json
"@sheldon/plugin-host": "*",
"@sheldon/plugin-sdk": "*"
```

Run: `npm install`

Expected: internal workspace links appear in `package-lock.json`.

- [ ] **Step 2: Write failing CLI tests**

Create `apps/cli/test/plugins.test.ts` with isolated `{ APPDATA: join(root, 'appdata') }` and a raw fixture plugin that does not require built dist output. Cover:

```ts
it('installs, lists, diagnoses, and removes a plugin', async () => {
  const installed = await runCli(['plugin', 'install', fixtureRoot], dependencies);
  expect(installed).toMatchObject({ exitCode: 0, stderr: '' });
  expect(installed.stdout).toContain('Plugin installed: fixture.raw@1.0.0');

  const beforeDoctor = await runCli(['plugin', 'list'], dependencies);
  expect(beforeDoctor.stdout).toContain('fixture.raw');
  expect(beforeDoctor.stdout).toContain('ready');
  expect(beforeDoctor.stdout).toContain('unchecked');

  const doctor = await runCli(['plugin', 'doctor', 'fixture.raw'], dependencies);
  expect(doctor).toMatchObject({ exitCode: 0, stderr: '' });
  expect(doctor.stdout).toContain('fixture.raw: healthy');

  const afterDoctor = await runCli(['plugin', 'list'], dependencies);
  expect(afterDoctor.stdout).toContain('healthy');
  expect(afterDoctor.stdout).toContain('last checked');

  const removed = await runCli(['plugin', 'remove', 'fixture.raw'], dependencies);
  expect(removed.stdout).toContain('Plugin removed: fixture.raw');
});
```

Add tests that list invalid/incompatible plugins with reasons and `sheldon plugin doctor <id>` guidance, return exit 1 for unhealthy doctor results, reject duplicate install, reject removing an official plugin, and render contract-test failures with the failed operation.

- [ ] **Step 3: Run CLI tests and observe the red state**

Run: `npx vitest run apps/cli/test/plugins.test.ts`

Expected: FAIL because the `plugin` command group is unknown.

- [ ] **Step 4: Expose the shared application-data root**

In `apps/cli/src/config.ts`, add:

```ts
export function appDataRoot(
  context: Pick<CommandContext, 'environment' | 'homeDirectory'>,
): string {
  return context.environment.APPDATA
    ? join(context.environment.APPDATA, 'Sheldon')
    : join(context.homeDirectory, '.config', 'sheldon');
}
```

Refactor `configPath` to return `join(appDataRoot(context), 'config.yaml')` so vault and plugin configuration share the same root without changing current behavior.

- [ ] **Step 5: Compose plugin services per command**

In `commands/plugins.ts`, implement `withPluginServices(context, callback)`: open the registry at `appDataRoot(context)`, open `PluginStateDatabase` at `pluginAppPaths(root).stateDatabase` with retention 10,000, create the runner/discovery/doctor services, execute the callback, and close the database in `finally`. Official roots come from an injected `CommandContext.officialPluginRoots` defaulting to `[]` until official ingestion plugins are added.

Implement exported command functions:

```ts
export async function installPlugin(directory: string, context: CommandContext): Promise<void>;
export async function removePlugin(id: string, context: CommandContext): Promise<void>;
export async function listPlugins(context: CommandContext): Promise<void>;
export async function doctorPlugin(id: string, context: CommandContext): Promise<void>;
export async function testPlugin(directory: string, context: CommandContext): Promise<void>;
```

List output uses one tab-separated line per entry with columns `ID`, `ORIGIN`, `VERSION`, `DISCOVERY`, `HEALTH`, `LICENSE`, `CAPABILITIES`, `DETAIL`. Invalid entries are never filtered. Healthy/unhealthy lines include `last checked <ISO timestamp>`; unchecked lines suggest doctor.

Throw `PluginHostError` for unhealthy results so CLI exits 1 after printing every check. Contract test prints one line per check and throws when any `passed` is false.

- [ ] **Step 6: Register Commander commands and actionable host errors**

In `createProgram` add:

```ts
const plugin = program.command('plugin');
plugin
  .command('install <directory>')
  .action((directory: string) => installPlugin(directory, context));
plugin.command('remove <id>').action((id: string) => removePlugin(id, context));
plugin.command('list').action(() => listPlugins(context));
plugin.command('doctor <id>').action((id: string) => doctorPlugin(id, context));
plugin.command('test <directory>').action((directory: string) => testPlugin(directory, context));
```

Extend `CommandContext`/`CliDependencies` with `officialPluginRoots?: readonly string[]`. In `runCli`, catch `PluginHostError` before the generic branch and render its message, target, and recovery exactly like `VaultError`.

- [ ] **Step 7: Verify the complete CLI command group**

Run: `npx vitest run apps/cli/test/plugins.test.ts apps/cli/test/cli.test.ts`

Expected: both CLI files pass and existing vault commands remain unchanged.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Document and commit plugin CLI behavior**

Add runnable examples for all five plugin commands and their output/status meanings to README. Add the plugin command group to the M1 changelog group.

```powershell
git add apps/cli package-lock.json README.md CHANGELOG.md
git commit -m "feat(cli): manage local plugins"
```

### Task 10: M1 acceptance gate, plugin lint, and public documentation

**Files:**

- Create: `apps/cli/test/plugin-acceptance.test.ts`
- Create: `scripts/verify-plugin-manifests.mjs`
- Modify: `scripts/verify-domain.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`
- Modify: `docs/roadmap.md`

**Interfaces:**

- Consumes: the complete M1 behavior.
- Produces: PRD 002 acceptance evidence, manifest domain lint, documented author/user workflows, and completed M1 roadmap status.

- [ ] **Step 1: Write milestone acceptance tests over public package APIs**

Create `apps/cli/test/plugin-acceptance.test.ts` with isolated application data and real raw process fixtures. Cover each PRD 002 acceptance criterion in named tests:

```ts
describe('PRD 002 acceptance', () => {
  it('runs a raw external fixture through the reusable contract', async () => {
    const report = await runPluginContract(rawContractFixtureRoot);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.operation)).toContain('cancel');
  });

  it('rejects invalid JSON without returning or promoting artifacts', async () => {
    const harness = await createAcceptanceHarness({ mode: 'malformed' });
    await expect(harness.runner.describe(harness.plugin)).rejects.toMatchObject({
      code: 'PLUGIN_PROTOCOL_INVALID_JSON',
    });
    expect(await readdir(harness.operationRoot)).toEqual([]);
    harness.close();
  });

  it.skipIf(process.platform !== 'win32')(
    'kills a timed-out plugin and every descendant',
    async () => {
      const harness = await createAcceptanceHarness({ mode: 'slow-tree', ingestTimeout: 100 });
      await expect(
        harness.runner.ingest(harness.plugin, { kind: 'fixture' }, {}, async () => undefined),
      ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
      const pid = Number(/descendant-pid:(\d+)/.exec(harness.state.listRuns()[0].stderrTail)?.[1]);
      await expect.poll(() => isProcessAlive(pid)).toBe(false);
      expect(await readdir(harness.operationRoot)).toEqual([]);
      harness.close();
    },
  );

  it('cancels with a clear diagnostic and no remaining artifacts', async () => {
    const harness = await createAcceptanceHarness({ mode: 'cooperative-cancel' });
    const controller = new AbortController();
    const result = harness.runner.ingest(
      harness.plugin,
      { kind: 'fixture' },
      {},
      async () => undefined,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
    expect(harness.state.listRuns()[0]).toMatchObject({ status: 'cancelled' });
    expect(await readdir(harness.operationRoot)).toEqual([]);
    harness.close();
  });

  it('accepts valid results when the plugin logs to stderr', async () => {
    const harness = await createAcceptanceHarness({ mode: 'normal' });
    await expect(harness.runner.healthcheck(harness.plugin)).resolves.toMatchObject({
      stderrTail: expect.stringContaining('fixture log'),
    });
    harness.close();
  });

  it('rejects missing or incompatible licenses for official plugins', () => {
    expect(() => parsePluginManifest({ ...manifest, license: 'GPL-3.0-only' }, 'official')).toThrow(
      /official license/i,
    );
    const withoutLicense = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== 'license'),
    );
    expect(() => parsePluginManifest(withoutLicense, 'official')).toThrow(/license/i);
  });
});
```

Define `createAcceptanceHarness` in the same file to create a temporary plugin root, state database, explicit operation-temp root, and runner using the real fixture modes from Tasks 5–6; return a synchronous `close()` that closes SQLite while `afterEach` removes filesystem roots. Define `isProcessAlive(pid)` with `process.kill(pid, 0)` and a try/catch. Add one assertion to the malformed case that the run record contains duration/plugin version/error code but `JSON.stringify(record)` does not contain the injected marker `acceptance-secret`. The post-build script remains the evidence for the SDK-built Node and PowerShell fixtures.

- [ ] **Step 2: Run the completed milestone acceptance tests**

Run: `npx vitest run apps/cli/test/plugin-acceptance.test.ts`

Expected: PASS; on Windows the descendant test executes.

- [ ] **Step 3: Add manifest domain lint**

Create `scripts/verify-plugin-manifests.mjs`. Import `parsePluginManifest` and `parseContractFixture` from the built SDK, recursively find `sheldon-plugin.json` below `test-fixtures/plugins` and a future root `plugins` when it exists, validate fixture manifests as installed plugins, validate an adjacent contract file when present, print one concise error per invalid file, and exit non-zero when any error exists.

Modify `scripts/verify-domain.mjs` to preserve the vault checks and then dynamically import `./verify-plugin-manifests.mjs`. The root verify order already builds before domain lint, so the built SDK is available.

- [ ] **Step 4: Add the post-build contract gate**

Add to root `package.json`:

```json
"verify:plugin-contract": "node scripts/verify-plugin-contract.mjs"
```

Change `verify` so `npm run verify:plugin-contract` runs immediately after `npm run build` and before `npm run lint:domain`.

Run: `npm run build`

Expected: PASS.

Run: `npm run verify:plugin-contract`

Expected: both fixtures report `contract passed`.

Run: `npm run lint:domain`

Expected: domain lint exits 0.

- [ ] **Step 5: Document the public plugin workflow**

Update `README.md` with:

- M1 status and the two package responsibilities;
- application-data layout (`plugins/`, `plugin-registry.yaml`, `plugin-state.db`);
- all five `sheldon plugin` commands with examples;
- health/discovery status meanings and stale last-known health;
- a minimal `definePlugin`/`runPlugin` TypeScript example;
- JSONL/stdout, stderr logs, temporary artifacts, permissions, and the explicit warning that process isolation is not an OS sandbox;
- `npm run verify:plugin-contract` in development commands.

Update `CHANGELOG.md` under `Unreleased > Added` with the protocol, SDK, host, CLI, contract fixtures, timeout/cancellation, and plugin quality gate.

Update `docs/README.md` to link the M1 design and implementation plan. Update `docs/roadmap.md` M1 to `concluído em 18 de julho de 2026` only after all acceptance tests pass, summarizing Node SDK and PowerShell contract evidence.

- [ ] **Step 6: Run the complete verification gate**

Run: `npm run verify`

Expected:

- Prettier, ESLint, typecheck, Markdown lint: PASS.
- Vitest: all unit, integration, CLI, and PRD 002 acceptance tests pass.
- Coverage: at least 80% statements/functions/lines and 70% branches.
- SWC build: emits core, vault, persistence, plugin SDK, plugin host, and CLI.
- Node SDK and PowerShell contracts: PASS.
- Vault and plugin domain lints: PASS.
- Repository change policy and `git diff --check`: PASS.

- [ ] **Step 7: Commit the completed milestone**

```powershell
git add apps/cli/test/plugin-acceptance.test.ts scripts package.json README.md CHANGELOG.md docs/README.md docs/roadmap.md
git commit -m "feat: complete plugin platform milestone"
```

## Requirement traceability

| Design/PRD area                                                            | Implemented and verified by                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Manifest v1, SPDX, protocol compatibility, result schemas                  | Tasks 1, 7, 10                                           |
| TypeScript author SDK and JSONL/stdout/stderr contract                     | Tasks 1, 2, 8                                            |
| Local copy install, duplicate rejection, no hidden execution, safe removal | Task 4; CLI evidence in Task 9                           |
| Discovery of official/installed/invalid plugins and fast list health       | Tasks 3, 7, 9                                            |
| Probe confidence, priority, explicit override, ambiguity                   | Task 7                                                   |
| Ephemeral processes, sanitized environment, output limits, run records     | Tasks 3, 5                                               |
| Unique temporary directory, artifact containment/hash/size validation      | Task 6                                                   |
| Timeout, cooperative cancel, Windows descendant termination, cleanup       | Tasks 2, 6, 10                                           |
| Named healthcheck/doctor with severity and remediation                     | Tasks 7, 9                                               |
| Shared Node SDK and raw PowerShell contract fixtures                       | Task 8; final gate in Task 10                            |
| README, changelog, plugin domain lint, roadmap completion                  | Incremental task commits; final consolidation in Task 10 |
