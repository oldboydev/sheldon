import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  definePlugin,
  runPlugin,
  type PluginImplementation,
  type RequestEnvelope,
} from '../src/index.js';

const description = {
  id: 'fixture',
  name: 'Fixture plugin',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['fixture'],
  priority: 10,
  platforms: ['win32'],
  permissions: { network: false, cookies: false },
  dependencies: [],
} as const;

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

describe('TypeScript plugin runner', () => {
  it('dispatches describe', async () => {
    const result = await execute(implementation, request('describe-1', 'describe', {}));

    expect(result.responses).toEqual([
      {
        protocolVersion: '1',
        requestId: 'describe-1',
        status: 'success',
        result: description,
      },
    ]);
  });

  it('returns after the primary response without waiting for stdin to end', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.write(`${JSON.stringify(request('describe-1', 'describe', {}))}\n`);
    const running = runPlugin(implementation, { input, output });

    const completed = await Promise.race([
      running.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    input.destroy();
    await running.catch(() => undefined);

    expect(completed).toBe(true);
  });

  it('dispatches probe', async () => {
    const result = await execute(
      implementation,
      request('probe-1', 'probe', { input: { kind: 'fixture' } }),
    );

    expect(result.responses).toEqual([
      {
        protocolVersion: '1',
        requestId: 'probe-1',
        status: 'success',
        result: {
          supported: true,
          confidence: 90,
          reason: 'fixture supported',
        },
      },
    ]);
  });

  it('dispatches ingest', async () => {
    const artifacts = [
      {
        id: 'artifact-1',
        role: 'normalized',
        path: 'content.md',
        mediaType: 'text/markdown',
        bytes: 7,
        sha256: 'a'.repeat(64),
      },
    ] as const;
    const ingesting = definePlugin({
      ...implementation,
      ingest: async () => artifacts,
    });

    const result = await execute(
      ingesting,
      request('ingest-1', 'ingest', {
        input: { kind: 'fixture' },
        options: {},
        temporaryDirectory: 'C:\\temp\\operation',
      }),
    );

    expect(result.responses[0]).toMatchObject({
      requestId: 'ingest-1',
      status: 'success',
      result: artifacts,
    });
  });

  it('dispatches healthcheck and writes context logs only to stderr', async () => {
    const checking = definePlugin({
      ...implementation,
      healthcheck: async (context) => {
        context.log('fixture healthy');
        return { checks: [] };
      },
    });

    const result = await execute(checking, request('health-1', 'healthcheck', {}));

    expect(result.responses[0]).toMatchObject({
      requestId: 'health-1',
      status: 'success',
      result: { checks: [] },
    });
    expect(result.stderr).toBe('fixture healthy\n');
    expect(result.stdout).not.toContain('fixture healthy');
  });

  it('converts implementation exceptions into protocol errors without stack traces', async () => {
    const failing = definePlugin({
      ...implementation,
      describe: async () => {
        throw new Error('fixture exploded');
      },
    });

    const result = await execute(failing, request('describe-1', 'describe', {}));

    expect(result.responses).toEqual([
      {
        protocolVersion: '1',
        requestId: 'describe-1',
        status: 'error',
        error: {
          code: 'PLUGIN_OPERATION_FAILED',
          message: 'fixture exploded',
        },
      },
    ]);
    expect(result.stdout).not.toContain('runner.test.ts');
  });

  it('acknowledges cooperative cancel and terminates the primary request as cancelled', async () => {
    let cancelledTarget: string | undefined;
    const cancellable = definePlugin({
      ...implementation,
      cancel: async (targetRequestId) => {
        cancelledTarget = targetRequestId;
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = '';
    output.on('data', (chunk) => (stdout += chunk.toString()));
    const running = runPlugin(cancellable, { input, output });

    input.write(
      `${JSON.stringify(
        request('ingest-1', 'ingest', {
          input: { kind: 'fixture' },
          options: {},
          temporaryDirectory: 'C:\\temp\\operation',
        }),
      )}\n`,
    );
    input.end(
      `${JSON.stringify(request('cancel-1', 'cancel', { targetRequestId: 'ingest-1' }))}\n`,
    );
    await running;

    const responses = decode(stdout);
    expect(cancelledTarget).toBe('ingest-1');
    expect(responses).toEqual(
      expect.arrayContaining([
        {
          protocolVersion: '1',
          requestId: 'cancel-1',
          status: 'success',
          result: {},
        },
        {
          protocolVersion: '1',
          requestId: 'ingest-1',
          status: 'cancelled',
          error: {
            code: 'PLUGIN_CANCELLED',
            message: 'Plugin operation cancelled.',
          },
        },
      ]),
    );
  });
});

function request(
  requestId: string,
  operation: RequestEnvelope['operation'],
  payload: RequestEnvelope['payload'],
): RequestEnvelope {
  return { protocolVersion: '1', requestId, operation, payload } as RequestEnvelope;
}

async function execute(implementationUnderTest: PluginImplementation, envelope: RequestEnvelope) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '';
  let stderr = '';
  output.on('data', (chunk) => (stdout += chunk.toString()));
  error.on('data', (chunk) => (stderr += chunk.toString()));
  input.end(`${JSON.stringify(envelope)}\n`);

  await runPlugin(implementationUnderTest, { input, output, error });

  return { stdout, stderr, responses: decode(stdout) };
}

function decode(text: string): unknown[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
