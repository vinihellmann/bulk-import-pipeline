/** Unit tests: no external services required. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__/unit'],
  testMatch: ['**/*.test.ts'],
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
};
