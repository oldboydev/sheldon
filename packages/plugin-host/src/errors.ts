export class PluginHostError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly target: string,
    public readonly recovery: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginHostError';
  }
}
