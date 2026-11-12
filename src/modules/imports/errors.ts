/** The uploaded file cannot be processed no matter how often we retry (bad header, corrupt file). */
export class InvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFileError';
  }
}

/** The Redis lock was lost while processing; another worker may own the job now. */
export class LockLostError extends Error {
  constructor(importId: string) {
    super(`Lock for import ${importId} was lost`);
    this.name = 'LockLostError';
  }
}

/** Processing was interrupted because the worker is shutting down. */
export class ShutdownError extends Error {
  constructor() {
    super('Worker is shutting down');
    this.name = 'ShutdownError';
  }
}

/** Thrown by the repository when the idempotency key unique constraint is violated. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super('Idempotency key already exists');
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
