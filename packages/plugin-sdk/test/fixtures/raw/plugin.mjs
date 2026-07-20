import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const description = {
  id: 'fixture.raw',
  name: 'Raw JSONL fixture',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['fixture'],
  priority: 10,
  platforms: ['win32'],
  permissions: { network: false, cookies: false },
  dependencies: [],
};

const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });
let active;

function respond(requestId, status, body) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: '1', requestId, status, ...body })}\n`);
}

for await (const line of lineReader) {
  const request = JSON.parse(line);
  if (request.operation === 'cancel') {
    respond(request.requestId, 'success', { result: {} });
    if (active?.requestId === request.payload.targetRequestId) {
      respond(active.requestId, 'cancelled', {
        error: { code: 'PLUGIN_CANCELLED', message: 'Cancelled by contract fixture.' },
      });
    }
    break;
  }
  if (request.operation === 'describe') {
    respond(request.requestId, 'success', { result: description });
    break;
  }
  if (request.operation === 'probe') {
    if (request.payload.input.kind === 'malformed') {
      process.stdout.write('{"not":"a protocol response"}\n');
    } else {
      const supported = request.payload.input.kind === 'fixture';
      respond(request.requestId, 'success', {
        result: {
          supported,
          confidence: supported ? 90 : 0,
          reason: supported ? 'supported' : 'unsupported',
        },
      });
    }
    break;
  }
  if (request.operation === 'healthcheck') {
    process.stderr.write('raw fixture healthy\n');
    respond(request.requestId, 'success', {
      result: { checks: [{ id: 'raw-health', severity: 'info', message: 'healthy' }] },
    });
    break;
  }
  if (request.operation === 'ingest') {
    active = request;
    if (request.payload.input.wait === true) continue;
    const content = '# Raw fixture\n';
    await writeFile(join(request.payload.temporaryDirectory, 'content.md'), content, 'utf8');
    respond(request.requestId, 'success', {
      result: [
        {
          id: 'content',
          role: 'normalized',
          path: 'content.md',
          mediaType: 'text/markdown',
          bytes: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    });
    break;
  }
}
