import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Permanent once published on Google Play — confirm before the first release.
  appId: 'app.halqa.quran',
  appName: 'الحلقة',
  webDir: 'dist',
  android: {
    // Matches the ivory app background so there is no white flash while the WebView loads.
    backgroundColor: '#F7F3E8',
  },
  plugins: {
    // Edge-to-edge: the WebView draws behind the system bars and the app pads itself with
    // env(safe-area-inset-*) (see AppShell). LIGHT = dark icons for the ivory background.
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover', style: 'LIGHT' },
  },
};

export default config;
