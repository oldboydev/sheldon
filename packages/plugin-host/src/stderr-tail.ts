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

    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (end >= start) {
      try {
        return decoder.decode(this.value.subarray(start, end));
      } catch {
        end -= 1;
      }
    }
    return '';
  }
}
