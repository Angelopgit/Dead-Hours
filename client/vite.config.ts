import { defineConfig } from 'vite';

/** Libraries in chunks of their own: they change far less often than the game, so returning players keep them cached. */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/three/')) return 'three';
  if (id.includes('/@dimforge/')) return 'rapier';
  if (id.includes('/gsap/')) return 'gsap';
  return undefined;
}

export default defineConfig(({ mode }) => {
  // `vite build --mode single` (npm run build:single): everything in one script and one stylesheet,
  // fonts and sounds inlined, for pasting into a single self-contained page (the playable Artifact).
  // The normal build is for a web host: separate, cacheable files, loaded as the page needs them.
  const single = mode === 'single';
  return {
    // The trailer tools (tools/trailer) write their output while a page renders; a reload would wreck it.
    server: { port: 5173, host: true, watch: { ignored: ['**/tools/**'] } },
    // Relative base so the build runs from any static host or folder.
    base: './',
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4000,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      modulePreload: !single,
      rollupOptions: { output: single ? { inlineDynamicImports: true } : { manualChunks: vendorChunk } },
    },
    // The light bake's workers import modules of their own.
    worker: { format: 'es' },
    // KTX2Loader finds its transcoder next to itself (new URL(..., import.meta.url)): pre-bundled, it would
    // look in the wrong folder on the dev server and never load the textures.
    optimizeDeps: { exclude: ['@dimforge/rapier3d-compat', 'three/examples/jsm/loaders/KTX2Loader.js'] },
  };
});
