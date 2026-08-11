import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src'),
};

export default defineConfig({
  main: {
    // better-sqlite3 and pino must stay external: they are native / use
    // dynamic worker resolution that bundling would break.
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    // Deliberately NOT externalizeDepsPlugin, and deliberately CommonJS.
    //
    // The preload runs with sandbox: true, which imposes two constraints that
    // are easy to violate silently:
    //   - a sandboxed preload cannot be an ES module, so the output must be
    //     .cjs (plain .js would be read as ESM because package.json sets
    //     "type": "module");
    //   - a sandboxed preload's `require` only resolves electron and a couple
    //     of builtins, so anything from node_modules — zod, reached via the
    //     IPC contract — must be bundled in rather than externalised.
    // Both failures only appear at runtime as a blank window, so they are
    // pinned here rather than left to defaults.
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
