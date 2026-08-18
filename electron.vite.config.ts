import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Which commit this build came from, stamped in at build time.
 *
 * The version in package.json is `0.1.0` and has never moved, so it answers
 * nothing. What is actually needed is "which code is this?" — and needing it
 * is not hypothetical: three separate features were reported missing that had
 * already shipped, each time because the launcher's `git pull` had quietly
 * failed and the app was running from weeks-old source. Nothing on screen
 * could have revealed that.
 *
 * Read from git rather than written by hand so it cannot drift, and wrapped
 * because a build from a downloaded ZIP has no git at all — which is itself
 * one of the situations worth being able to see.
 */
function buildStamp(): { commit: string; committedAt: string; builtAt: string } {
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };

  return {
    commit: git('rev-parse --short HEAD') ?? 'unknown',
    committedAt: git('log -1 --format=%cI') ?? 'unknown',
    builtAt: new Date().toISOString(),
  };
}

const BUILD = buildStamp();
const define = {
  __BUILD_COMMIT__: JSON.stringify(BUILD.commit),
  __BUILD_COMMITTED_AT__: JSON.stringify(BUILD.committedAt),
  __BUILD_AT__: JSON.stringify(BUILD.builtAt),
};

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
    define,
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
