import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'node:fs';

export default defineConfig({
  plugins: [react(), {
    name: 'copy-game-art',
    closeBundle() { cpSync('Images', 'dist/Images', { recursive: true }); },
  }],
});
