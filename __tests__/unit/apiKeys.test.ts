import { createApiKeyAuthenticator, hashApiKey, parseApiKeys } from '../../src/shared/auth/apiKeys';

const hashA1 = hashApiKey('a'.repeat(40));
const hashA2 = hashApiKey('b'.repeat(40));
const hashB = hashApiKey('c'.repeat(40));

describe('hashApiKey', () => {
  it('is a deterministic sha256 hex digest', () => {
    expect(hashApiKey('local-dev-api-key-change-me')).toBe(
      'dbfa6e71cf9164ee80524dd80b61c77d644fe0d937258cbb6c280a1ce36700fe',
    );
  });
});

describe('parseApiKeys', () => {
  it('parses several entries, including multiple keys per client', () => {
    expect(
      parseApiKeys(` clienta:${hashA1}, clienta:${hashA2.toUpperCase()},clientb:${hashB} `),
    ).toEqual([
      { clientId: 'clienta', hash: hashA1 },
      { clientId: 'clienta', hash: hashA2 },
      { clientId: 'clientb', hash: hashB },
    ]);
  });

  it.each([
    ['missing separator', 'nohash'],
    ['bad client id', `Bad Client:${hashA1}`],
    ['short hash', 'clienta:abc123'],
    ['duplicate hash', `a:${hashA1},b:${hashA1}`],
  ])('rejects %s', (_name, spec) => {
    expect(() => parseApiKeys(spec)).toThrow(/API_KEYS/);
  });
});

describe('createApiKeyAuthenticator', () => {
  const auth = createApiKeyAuthenticator([
    { clientId: 'clienta', hash: hashA1 },
    { clientId: 'clienta', hash: hashA2 },
    { clientId: 'clientb', hash: hashB },
  ]);

  it('resolves any of a client keys to its principal with a stable keyId', () => {
    expect(auth.authenticate('a'.repeat(40))).toEqual({
      clientId: 'clienta',
      keyId: hashA1.slice(0, 12),
    });
    expect(auth.authenticate('b'.repeat(40))).toEqual({
      clientId: 'clienta',
      keyId: hashA2.slice(0, 12),
    });
    expect(auth.authenticate('c'.repeat(40))?.clientId).toBe('clientb');
  });

  it('rejects unknown, empty, non-string and oversized keys', () => {
    expect(auth.authenticate('nope')).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
    expect(auth.authenticate(['a'.repeat(40)])).toBeNull();
    expect(auth.authenticate('a'.repeat(513))).toBeNull();
  });
});
