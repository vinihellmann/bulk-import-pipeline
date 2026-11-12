/**
 * The authenticated caller. `clientId` is the tenant boundary: every import belongs to exactly
 * one client and is invisible to the others. `keyId` identifies which of the client's keys was
 * used (safe to log; derived from the key hash, never the key itself), which makes rotation
 * observable.
 */
export interface Principal {
  clientId: string;
  keyId: string;
}

/** Client ids end up in S3 keys and log lines, so their alphabet is deliberately narrow. */
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
