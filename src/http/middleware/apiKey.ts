import type { RequestHandler } from 'express';
import type { ApiKeyAuthenticator } from '../../shared/auth/apiKeys';
import { UnauthorizedError } from '../../shared/errors';

/**
 * Machine-to-machine authentication. Resolves the `x-api-key` header to a tenant
 * `Principal` (constant-time, hashed comparison) and tags the request logger with it.
 */
export function apiKeyAuth(authenticator: ApiKeyAuthenticator): RequestHandler {
  return (req, _res, next) => {
    const principal = authenticator.authenticate(req.get('x-api-key'));
    if (!principal) {
      next(new UnauthorizedError('Missing or invalid API key'));
      return;
    }
    req.principal = principal;
    req.log = req.log.child({ clientId: principal.clientId, keyId: principal.keyId });
    next();
  };
}
