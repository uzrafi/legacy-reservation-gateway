/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit', '<rootDir>/test/contract'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/local/**'],
};
