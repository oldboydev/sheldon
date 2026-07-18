import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const noValue = Symbol('no JSONL value');

export class JsonlReader {
  private readonly iterator;
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  private bufferedBytes = 0;
  private remainder: Buffer | undefined;

  public constructor(
    stream: Readable,
    private readonly lineLimitBytes: number,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  public async next(): Promise<unknown | undefined> {
    while (true) {
      if (this.remainder !== undefined) {
        const value = this.consume(this.remainder);
        if (value !== noValue) return value;
      }

      const item = await this.iterator.next();
      if (item.done) {
        this.buffered += this.decoder.end();
        if (this.buffered.length === 0) return undefined;
        throw new Error('JSONL stream ended with an unterminated line.');
      }

      this.remainder = Buffer.isBuffer(item.value)
        ? item.value
        : Buffer.from(item.value as Uint8Array);
    }
  }

  private consume(chunk: Buffer): unknown | typeof noValue {
    const newline = chunk.indexOf(0x0a);
    const segment = newline < 0 ? chunk : chunk.subarray(0, newline);
    this.append(segment);

    if (newline < 0) {
      this.remainder = undefined;
      return noValue;
    }

    this.remainder = newline + 1 < chunk.length ? chunk.subarray(newline + 1) : undefined;
    const line = `${this.buffered}${this.decoder.end()}`.replace(/\r$/, '');
    this.buffered = '';
    this.bufferedBytes = 0;
    if (line.length === 0) return noValue;

    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error('Invalid JSONL line.', { cause: error });
    }
  }

  private append(segment: Buffer): void {
    this.bufferedBytes += segment.length;
    if (this.bufferedBytes > this.lineLimitBytes) {
      throw new Error('JSONL line limit exceeded.');
    }
    this.buffered += this.decoder.write(segment);
  }
}

export async function writeJsonl(stream: Writable, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (!stream.write(line, 'utf8')) await once(stream, 'drain');
}
