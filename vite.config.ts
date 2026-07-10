import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@mdx-js/rollup';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [mdx(), react(), tailwindcss()],
});
