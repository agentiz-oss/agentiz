import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The site's own build, separate from the root vite.config.ts (which builds the panel modules).
// Client and SSR are two runs of this file: `vite build` and `vite build --ssr`.
export default defineConfig((env) => {
  // vite 5 renamed `ssrBuild` to `isSsrBuild`; accept both so a vite upgrade does not quietly
  // build the SSR bundle with the client settings.
  const isSsrBuild = (env as { isSsrBuild?: boolean; ssrBuild?: boolean }).isSsrBuild
    ?? (env as { ssrBuild?: boolean }).ssrBuild
    ?? false;
  const rootDir = path.resolve(import.meta.dirname);

  return {
    root: rootDir,
    base: '/site-assets/',
    plugins: [react()],
    // The stylesheet is plain CSS. Without this Vite would walk up to the repository's
    // postcss.config.cjs and run Tailwind over it.
    css: { postcss: { plugins: [] } },
    resolve: {
      dedupe: ['react', 'react-dom', '@inertiajs/react'],
    },
    build: isSsrBuild
      ? {
          outDir: path.resolve(rootDir, 'dist/server'),
          emptyOutDir: true,
          // The renderer prints asset URLs into <head>; emitting them here keeps the hashes the
          // same as in the client build.
          ssrEmitAssets: true,
          rollupOptions: { output: { entryFileNames: 'ssr.js', format: 'es' } },
        }
      : {
          manifest: true,
          outDir: path.resolve(rootDir, 'dist/client'),
          emptyOutDir: true,
          rollupOptions: {
            input: path.resolve(rootDir, 'src/app.tsx'),
            output: {
              entryFileNames: '[name]-[hash].js',
              chunkFileNames: 'assets/[name]-[hash].js',
              assetFileNames: 'assets/[name]-[hash][extname]',
            },
          },
        },
  };
});
