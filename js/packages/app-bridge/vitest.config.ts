import { defineConfig } from 'vitest/config';

// node:test covers the framework-free SDK; the React bindings need a DOM.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.tsx'],
  },
});
