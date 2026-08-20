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
});
