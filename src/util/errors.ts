/** A user-facing error: printed without a stack trace. */
export class RecallError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "RecallError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
