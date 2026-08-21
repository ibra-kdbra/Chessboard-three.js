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
      include: ['src/core/**', 'src/engine/**'],
      exclude: ['src/data/**'],
      reporter: ['text-summary'],
    },
  },
});
