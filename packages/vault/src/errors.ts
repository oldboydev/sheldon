export class VaultError extends Error {
  public constructor(
    message: string,
    public readonly target: string,
    public readonly recovery: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VaultError';
  }
}
