/**
 * Integration tests: need MySQL, Redis, MinIO and ElasticMQ. Run them inside the compose
 * network with `npm run test:docker` (see docker-compose.test.yml).
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__/integration'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
  },
  clearMocks: true,
  // Every client is closed in afterAll; this only guards CI against a hung driver socket.
  forceExit: true,
};
