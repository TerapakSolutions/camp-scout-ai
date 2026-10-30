module.exports = {
  testEnvironment: 'jsdom',
  moduleFileExtensions: ['js', 'jsx', 'ts', 'tsx'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '\\.(png|jpg|jpeg|gif|svg)$': '<rootDir>/__mocks__/fileMock.js',
  },
  setupFilesAfterEnv: ['@testing-library/jest-dom'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/main.jsx',
    '!src/assets/**',
    '!src/styles/**',
  ],
  // Coverage FLOOR, not a target: ~3 points under what the suite measured on 2026-10-30
  // (statements 74.06, branches 63.2, functions 77.65, lines 75.34), rounded down. It stops
  // coverage silently eroding; raise it when coverage rises, never lower it to get a PR green.
  coverageThreshold: {
    global: {
      statements: 71,
      branches: 60,
      functions: 74,
      lines: 72,
    },
  },
}; 