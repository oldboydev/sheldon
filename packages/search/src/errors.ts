export class SearchIndexError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchIndexError';
  }
}

export class QueryServiceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QueryServiceError';
  }
}
