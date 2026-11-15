/* Which browsers may install HALQA as an app (owner report, 14–15 Nov 2026: Google Play Protect blocked «الحلقة»
   installed from Samsung Internet).

   On Android, installing a web app makes the BROWSER build an app package. Google Chrome's is minted and signed by
   Google; other browsers (Samsung Internet, Edge, Opera, Brave, Yandex, Mi, Huawei…) build their own, which Play
   Protect blocks as «built for an older version of Android».

   So the web app manifest is linked only where installing is safe: every non-Android browser (iPhone Add to Home
   Screen, desktop) and Google Chrome on Android. Other Android browsers then offer no install of their own (no
   address-bar install icon, no menu item), and HALQA's «تثبيت التطبيق» sends them to Chrome (src/pwa/install.ts;
   keep the browser list in step). Loaded as a same-origin file because the CSP allows no inline scripts. */
(function () {
  var s = document.currentScript;
  var href = (s && s.getAttribute('data-manifest')) || '/manifest.webmanifest';
  var ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) {
    var other = /SamsungBrowser|EdgA\/|Edg\/|OPR\/|OPT\/|Opera|YaBrowser|YaSearchBrowser|Vivaldi|MiuiBrowser|XiaoMi|HuaweiBrowser|HONORBrowser|DuckDuckGo|Firefox|FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|; wv\)/i.test(ua)
      || 'brave' in navigator || !/Chrome\/\d/.test(ua);
    if (other) return;
  }
  var l = document.createElement('link');
  l.rel = 'manifest';
  l.href = href;
  document.head.appendChild(l);
  // Chrome fires `beforeinstallprompt` once, possibly before the app's code has loaded (owner report 15 Nov 2026: no
  // install message appeared). Keep it here; src/pwa/install.ts picks it up when it starts.
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.__halqaInstallEvent = e; });
})();
