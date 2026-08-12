/**
 * Domain errors carrying an HTTP-ish code, so route handlers can map them to
 * responses without string-matching messages.
 *
 * Accounting rejections are expected outcomes, not crashes: posting into a
 * closed period or over-allocating a payment is the system working correctly.
 * They must reach the user as a precise, actionable message.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = 'bad_request',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'validation_error', details);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(`${entity} not found`, 404, 'not_found');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'forbidden');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

/**
 * A violation of an accounting rule: unbalanced entry, closed period, archived
 * account, over-allocation. Distinguished from generic validation so the UI can
 * present it with the accounting context that makes it fixable.
 */
export class AccountingError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'accounting_rule_violation', details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Maps any thrown value to a safe response shape; never leaks internals. */
export function toErrorResponse(err: unknown): {
  status: number;
  body: { error: string; code: string; details?: unknown };
} {
  if (isAppError(err)) {
    return {
      status: err.status,
      body: { error: err.message, code: err.code, details: err.details },
    };
  }
  console.error('Unhandled error:', err);
  return {
    status: 500,
    body: { error: 'An unexpected error occurred', code: 'internal_error' },
  };
}
