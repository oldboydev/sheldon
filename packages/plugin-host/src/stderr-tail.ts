export class StderrTail {
  private value = Buffer.alloc(0);

  public constructor(private readonly limitBytes: number) {}

  public consume(chunk: Uint8Array): void {
    if (this.limitBytes <= 0) {
      this.value = Buffer.alloc(0);
      return;
    }

    const combined = Buffer.concat([this.value, Buffer.from(chunk)]);
    this.value =
      combined.length <= this.limitBytes
        ? combined
        : combined.subarray(combined.length - this.limitBytes);
  }

  public text(): string {
    let start = 0;
    let end = this.value.length;
    while (start < end && (this.value[start]! & 0xc0) === 0x80) start += 1;
    end = completeUtf8End(this.value, start, end);
    return new TextDecoder('utf-8').decode(this.value.subarray(start, end));
  }
}

function completeUtf8End(value: Buffer, start: number, initialEnd: number): number {
  let end = initialEnd;
  while (end > start) {
    let lead = end - 1;
    let continuationBytes = 0;
    while (lead >= start && isContinuation(value[lead]!) && continuationBytes < 3) {
      lead -= 1;
      continuationBytes += 1;
    }

    const expected = lead < start ? 0 : expectedContinuationBytes(value[lead]!);
    if (continuationBytes > 0 && expected === 0) {
      end = lead + 1;
      continue;
    }
    if (expected === 0 || continuationBytes >= expected) return end;
    end = lead;
  }
  return end;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function expectedContinuationBytes(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 1;
  if (byte >= 0xe0 && byte <= 0xef) return 2;
  if (byte >= 0xf0 && byte <= 0xf4) return 3;
  return 0;
}
