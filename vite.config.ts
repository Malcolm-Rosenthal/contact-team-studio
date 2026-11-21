import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/contact-team-studio/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Contact Team Studio',
        short_name: 'Contact Team',
        description: 'Offline-first novel writing studio',
        theme_color: '#faf8f5',
        background_color: '#faf8f5',
        display: 'standalone',
        start_url: '/contact-team-studio/',
        scope: '/contact-team-studio/',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
    }),
  ],
});