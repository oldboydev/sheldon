export class ReviewError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly recovery: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
