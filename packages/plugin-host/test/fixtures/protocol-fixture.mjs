import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'success';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const request = await new Promise((resolve) =>
  input.once('line', (line) => resolve(JSON.parse(line))),
);

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

if (mode === 'cooperative-cancel') {
  const partialPath = join(request.payload.temporaryDirectory, 'partial.md');
  await writeFile(partialPath, 'partial');
  const cancel = await new Promise((resolve) =>
    input.once('line', (line) => resolve(JSON.parse(line))),
  );
  await rm(partialPath, { force: true });
  write(success({}, cancel.requestId));
  write({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    status: 'cancelled',
    error: { code: 'PLUGIN_CANCELLED', message: 'Fixture cancelled.' },
  });
  input.close();
} else if (mode === 'hang') {
  input.close();
  setInterval(() => {}, 1_000);
} else if (mode === 'malformed') {
  input.close();
  process.stdout.write('not-json\n');
} else if (mode === 'oversized-line') {
  input.close();
  process.stdout.write(`${'x'.repeat(2_048)}\n`);
} else if (mode === 'nonzero') {
  input.close();
  process.exitCode = 9;
} else {
  input.close();
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
              : mode === 'legacy-false'
                ? {
                    ...description,
                    permissions: { network: false, cookies: false, media: false },
                    effects: { ocr: false, stt: false, modelDownload: false },
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
          cookieFile: process.env.SHELDON_SOCIAL_COOKIE_FILE ?? null,
          path: process.env.PATH ?? null,
          temp: process.env.TEMP ?? null,
          tmp: process.env.TMP ?? null,
        }),
      };
      break;
    case 'healthcheck':
      process.stderr.write(
        mode === 'secret-stderr'
          ? `fixture log ${process.env.SHELDON_SOCIAL_COOKIE_FILE}\n`
          : 'fixture log\n',
      );
      result = {
        checks:
          mode === 'secret-stderr' && process.env.SHELDON_SOCIAL_COOKIE_FILE !== undefined
            ? [
                {
                  id: 'secret-environment',
                  severity: 'info',
                  message: 'Cookie environment received.',
                },
              ]
            : [],
      };
      break;
    case 'ingest': {
      const artifactContent = '# Fixture\n';
      await writeFile(join(request.payload.temporaryDirectory, 'content.md'), artifactContent);
      result = [
        {
          id: 'content',
          role: 'normalized',
          path: 'content.md',
          mediaType: 'text/markdown',
          bytes: mode === 'invalid-artifact' ? 1 : Buffer.byteLength(artifactContent),
          sha256: createHash('sha256').update(artifactContent).digest('hex'),
        },
      ];
      break;
    }
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
