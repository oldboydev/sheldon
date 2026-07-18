import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'success';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const request = await new Promise((resolve) =>
  input.once('line', (line) => resolve(JSON.parse(line))),
);
input.close();

const description = {
  id: 'fixture.node',
  name: 'Fixture Plugin',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['fixture', 'metadata'],
  priority: 10,
  platforms: [process.platform],
  permissions: { network: false, cookies: false },
  dependencies: [],
};

const success = (result, requestId = request.requestId) => ({
  protocolVersion: request.protocolVersion,
  requestId,
  status: 'success',
  result,
});

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === 'malformed') {
  process.stdout.write('not-json\n');
} else if (mode === 'oversized-line') {
  process.stdout.write(`${'x'.repeat(2_048)}\n`);
} else if (mode === 'nonzero') {
  process.exitCode = 9;
} else {
  let result;
  switch (request.operation) {
    case 'describe':
      result =
        mode === 'oversized-total'
          ? { ...description, name: 'x'.repeat(1_024) }
          : mode === 'identity-mismatch'
            ? { ...description, id: 'fixture.other' }
            : mode === 'equivalent-order'
              ? {
                  ...description,
                  capabilities: [...description.capabilities].reverse(),
                  permissions: { cookies: false, network: false },
                }
              : mode === 'invalid-result'
                ? { id: description.id }
                : description;
      break;
    case 'probe':
      result = {
        supported: true,
        confidence: 90,
        reason: JSON.stringify({
          secret: process.env.SHELDON_TEST_SECRET ?? null,
          path: process.env.PATH ?? null,
          temp: process.env.TEMP ?? null,
          tmp: process.env.TMP ?? null,
        }),
      };
      break;
    case 'healthcheck':
      process.stderr.write('fixture log\n');
      result = { checks: [] };
      break;
    default:
      throw new Error(`Unsupported fixture operation: ${request.operation}`);
  }

  const response =
    mode === 'error-echo'
      ? {
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          status: 'error',
          error: {
            code: request.payload.input.errorCode ?? 'PLUGIN_FIXTURE_ERROR',
            message: `Fixture rejected ${request.payload.input.secret}`,
          },
        }
      : success(
          result,
          mode === 'wrong-request' ? `${request.requestId}-wrong` : request.requestId,
        );
  write(response);

  if (mode === 'duplicate') write(response);
  if (mode === 'late-output') process.stdout.write('extra\n');
  if (mode === 'success-nonzero') process.exitCode = 9;
}
