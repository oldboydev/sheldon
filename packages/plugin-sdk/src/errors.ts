export class ProtocolValidationError extends Error {
  public constructor(
    message: string,
    public readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}
