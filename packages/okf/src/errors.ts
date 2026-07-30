export class OkfError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'OkfError';
  }
}
