import { defineConfig } from 'vite';

export default defineConfig({
  // The trailer tools (tools/trailer) write their output while a page renders; a reload would wreck it.
  server: { port: 5173, host: true, watch: { ignored: ['**/tools/**'] } },
  // Relative base and inlined assets so the build runs from any static host, including a single-file page.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 100_000_000, modulePreload: false },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
