/** Raised when a caller attempts to use knowledge outside its configured scope. */
export class McpScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'McpScopeError';
  }
}
