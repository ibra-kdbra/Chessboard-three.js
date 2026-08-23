import { defineConfig } from 'vitest/config';

/**
 * Unit tests cover the DOM-free core only. Anything that needs a browser — the
 * renderer, the engine workers, the app shell — is covered by Playwright
 * instead, because a jsdom approximation of WebGL or of a classic-script Worker
 * would test the approximation rather than the thing.
 *
 * Without this file vitest globs tests/e2e/*.spec.js too, and dies importing
 * @playwright/test.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    globals: false,
    reporters: process.env.CI ? ['default'] : ['dot'],
    coverage: {
      // src/app is in scope now that the DOM-free parts of it are tested; it
      // was 59% of src and invisible to coverage, which is how a module with
      // no tests at all looked the same as one with full coverage.
      include: ['src/core/**', 'src/engine/**', 'src/app/**'],
      exclude: ['src/data/**'],
      reporter: ['text-summary'],
    },
  },
});
