/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environmentMatchGlobs: [['**/*.dom.test.{ts,tsx}', 'jsdom']],
    setupFiles: ['./src/setup.dom.ts'],
  },
});
