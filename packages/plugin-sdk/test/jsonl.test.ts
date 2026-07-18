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

  it('decodes a UTF-8 code point split across chunks', async () => {
    const input = new PassThrough();
    const reader = new JsonlReader(input, 128);
    const line = Buffer.from('{"text":"ação"}\n');
    const split = line.indexOf(0xc3) + 1;
    input.write(line.subarray(0, split));
    input.end(line.subarray(split));

    await expect(reader.next()).resolves.toEqual({ text: 'ação' });
  });

  it('rejects malformed UTF-8 inside an otherwise valid JSON string', async () => {
    const input = new PassThrough();
    const reader = new JsonlReader(input, 128);
    input.end(
      Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]),
    );

    await expect(reader.next()).rejects.toThrow(/UTF-8/i);
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
