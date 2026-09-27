import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/earth-search': {
        target: 'https://earth-search.aws.element84.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/earth-search/, ''),
      },
    },
  },
});