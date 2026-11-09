/** Runs against a deployed stage. Needs API_BASE_URL, API_KEY_BASIC and a token (see test/integration/README). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testTimeout: 120000,
};
