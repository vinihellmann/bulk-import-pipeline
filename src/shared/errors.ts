export interface FieldIssue {
  location?: string;
  field: string;
  message: string;
}

/** Base class for errors that map to an HTTP problem response. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', issues: FieldIssue[] = []) {
    super(400, 'validation-error', message, issues);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'not-found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Request conflicts with current state') {
    super(409, 'conflict', message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please retry later') {
    super(429, 'too-many-requests', message);
  }
}
