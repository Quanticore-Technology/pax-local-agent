/**
 * Error carrying one of the wire-protocol ERROR_CODES back to the cloud.
 * Lives in its own module so command handlers can throw it without importing
 * the router that dispatches them.
 */
export class CommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}
