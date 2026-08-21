import { defineConfig } from 'vite';

// A relative base keeps the build portable: the same artifact works from a
// domain root, from a GitHub Pages project subpath (/<repo>/), and from
// file:// during a local audit. Routing is hash-based, so nothing depends on
// the server rewriting unknown paths to index.html.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // Filesystem events do not always reach the dev server — a sandboxed or
    // containerised environment can block them outright — and the failure is
    // silent: edits appear to do nothing while the browser is served the last
    // transform. Polling is a little more work for the machine and much less
    // for whoever would otherwise be debugging code that is not running.
    watch: { usePolling: true, interval: 300 },
  },
});
