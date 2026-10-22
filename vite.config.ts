import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const IVORY = '#F7F3E8';

/** The admin portal is its own installable app (admin/index.html links /admin/manifest.webmanifest). The PWA plugin
 *  adds the learners' manifest to every page; remove it from the admin page so each page has exactly one. */
const adminOwnManifest = {
  name: 'admin-own-manifest',
  enforce: 'post' as const,
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { path: string }) {
      return ctx.path.startsWith('/admin/') ? html.replace(/<link rel="manifest" href="\/manifest\.webmanifest"[^>]*>/g, '') : html;
    },
  },
};

export default defineConfig({
  plugins: [
    react(),
    // Installable PWA. The service worker precaches the app shell only. API calls (/api) and signed
    // media URLs are never cached: learner data and recordings must not persist on shared devices.
    VitePWA({
      registerType: 'prompt', // a new version waits until the user taps "update" (no reload mid-recording)
      injectRegister: null, // registered from src/pwa/PwaUpdate.tsx
      includeManifestIcons: false, // already matched by globPatterns; duplicates abort precaching
      manifest: {
        id: '/',
        name: 'الحلقة — تعلّم القرآن',
        short_name: 'الحلقة',
        description: 'حفظ ومراجعة وتجويد مع معلمك: واجبات، تسجيل التلاوة، تقييم المعلم، وحجز الجلسات.',
        lang: 'ar',
        dir: 'rtl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: IVORY,
        theme_color: IVORY,
        categories: ['education'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The admin portal is online only and must never run a cached old version: its page and icons are not
        // precached, so /admin/ always loads the current release from the network (23 Oct: a cached admin page
        // predating «تذكّر هذا الجهاز» never sent trust_device, so every sign-in asked for the code).
        globIgnores: ['admin/**'],
        importScripts: ['push-sw.js'], // Web Push handlers (public/push-sw.js)
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/admin\//],  // the admin app has its own page (online only)
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.googleapis\.com\//, handler: 'StaleWhileRevalidate', options: { cacheName: 'google-fonts-css' } },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    adminOwnManifest,
  ],
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), admin: fileURLToPath(new URL('./admin/index.html', import.meta.url)) } } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Dev: with VITE_API_BASE_URL=/ the app calls same-origin /api and Vite forwards it to Django.
  server: { proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:8000', changeOrigin: false } } },
  preview: { proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:8000', changeOrigin: false } } },
});
