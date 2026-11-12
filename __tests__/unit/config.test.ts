import { loadConfig } from '../../src/config/env';
import { hashApiKey } from '../../src/shared/auth/apiKeys';

const base = {
  S3_BUCKET: 'imports',
  SQS_QUEUE_URL: 'http://localhost:9324/000000000000/imports',
};
const hash = hashApiKey('x'.repeat(40));

describe('loadConfig', () => {
  it('maps the legacy API_KEY to the "default" client', () => {
    const config = loadConfig({ ...base, API_KEY: 'legacy-key-1234567890' });
    expect(config.auth.apiKeys).toEqual([
      { clientId: 'default', hash: hashApiKey('legacy-key-1234567890') },
    ]);
    expect(config.apiKey).toBe('legacy-key-1234567890');
  });

  it('parses API_KEYS and combines them with a legacy key', () => {
    const config = loadConfig({
      ...base,
      API_KEYS: `acme:${hash}`,
      API_KEY: 'legacy-key-1234567890',
    });
    expect(config.auth.apiKeys.map((k) => k.clientId)).toEqual(['acme', 'default']);
  });

  it('requires at least one key and a legacy key of 16+ chars', () => {
    expect(() => loadConfig(base)).toThrow(/Invalid environment configuration[\s\S]*API_KEYS/);
    expect(() => loadConfig({ ...base, API_KEY: 'short' })).toThrow(/API_KEY/);
  });

  it('reports malformed API_KEYS', () => {
    expect(() => loadConfig({ ...base, API_KEYS: 'acme:nothex' })).toThrow(/64 hex/);
  });

  it('applies defaults for the new settings', () => {
    const config = loadConfig({ ...base, API_KEYS: `acme:${hash}` });
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimit.ipLimit).toBe(600);
    expect(config.realtime.maxSubscriptionsPerSocket).toBe(20);
    expect(config.db.ssl).toEqual({ enabled: false, ca: undefined, rejectUnauthorized: true });
    expect(config.s3.sse).toBeUndefined();
    expect(config.warnings).toEqual([]);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['2', 2],
    ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
  ])('parses TRUST_PROXY=%s', (raw, expected) => {
    expect(loadConfig({ ...base, API_KEYS: `acme:${hash}`, TRUST_PROXY: raw }).trustProxy).toBe(
      expected,
    );
  });

  it('uses inline PEM as-is and rejects an unreadable CA path', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const ok = loadConfig({ ...base, API_KEYS: `a:${hash}`, DB_SSL: 'true', DB_SSL_CA: pem });
    expect(ok.db.ssl.ca).toBe(pem);
    expect(() =>
      loadConfig({ ...base, API_KEYS: `a:${hash}`, REDIS_TLS_CA: '/does/not/exist.pem' }),
    ).toThrow(/REDIS_TLS_CA/);
  });

  it('requires S3_SSE=aws:kms for a KMS key', () => {
    expect(() =>
      loadConfig({ ...base, API_KEYS: `a:${hash}`, S3_SSE: 'AES256', S3_KMS_KEY_ID: 'k' }),
    ).toThrow(/S3_KMS_KEY_ID/);
  });

  describe('production guards', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      API_KEYS: `acme:${hash}`,
      DB_PASSWORD: 's3cret',
    };

    it('accepts a hardened configuration and warns about missing TLS', () => {
      const config = loadConfig(prod);
      expect(config.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('DB_SSL is disabled')]),
      );
      expect(loadConfig({ ...prod, DB_SSL: 'true' }).warnings.join()).not.toContain('DB_SSL is');
    });

    it('rejects the legacy plaintext API_KEY', () => {
      expect(() => loadConfig({ ...prod, API_KEY: 'legacy-key-1234567890' })).toThrow(
        /not allowed in production/,
      );
    });

    it('requires an explicit DB_PASSWORD', () => {
      const { DB_PASSWORD: _omit, ...rest } = prod;
      expect(() => loadConfig(rest)).toThrow(/DB_PASSWORD/);
    });

    it('rejects wildcard CORS origins', () => {
      expect(() => loadConfig({ ...prod, CORS_ORIGINS: 'https://a.example,*' })).toThrow(
        /CORS_ORIGINS/,
      );
    });

    it('aggregates every problem in one error', () => {
      const bad = {
        ...base,
        NODE_ENV: 'production',
        API_KEY: 'legacy-key-1234567890',
        CORS_ORIGINS: '*',
      };
      expect(() => loadConfig(bad)).toThrow(/API_KEY[\s\S]*DB_PASSWORD[\s\S]*CORS_ORIGINS/);
    });
  });
});
