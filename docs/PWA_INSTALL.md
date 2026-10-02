# Snacky OS PWA Install

Snacky OS is a mobile-friendly PWA so operators can open their route workflow from the phone home screen. Install behavior depends on the browser and operating system.

## Before Installing

Use the correct app URL for the environment:

- Local testing: `http://localhost:<port>` in a desktop browser.
- Staging phone test: the Vercel staging or Preview HTTPS URL.
- Production phone use: the production HTTPS URL.

For real phones, use HTTPS. Mobile browsers usually do not offer home-screen install for non-HTTPS public sites.

## iPhone Or iPad

Use Safari:

1. Open the Snacky OS app URL.
2. Sign in once to confirm the account works.
3. Tap the Share button.
4. Tap Add to Home Screen.
5. Confirm the name is `Snacky`.
6. Tap Add.
7. Open Snacky OS from the home screen icon.

Expected result:

- The app opens in standalone mode.
- The Snacky icon is not cropped.
- Operator pages fit without horizontal scrolling.

## Android

Use Chrome:

1. Open the Snacky OS app URL.
2. Sign in once to confirm the account works.
3. Tap the Chrome menu.
4. Tap Add to Home Screen or Install App.
5. Confirm the name is `Snacky`.
6. Open Snacky OS from the home screen icon.

Expected result:

- The app opens in standalone mode.
- The Snacky icon is not cropped.
- Operator pages use mobile cards and touch-friendly controls.

## Staging PWA Test

Before production, test on staging:

1. Open `/install` and confirm the instructions match iPhone and Android flows.
2. Confirm `/manifest.webmanifest` returns `200`.
3. Confirm `/icons/icon-192.png`, `/icons/icon-512.png`, and `/icons/maskable-icon-512.png` return `200`.
4. Confirm `/sw.js` returns `200`.
5. Confirm `/offline.html` returns `200`.
6. Install from a phone and open from the home screen.
7. Sign in as an operator and complete the route screens on a 360px or 390px wide viewport.

## Troubleshooting

If install is not offered:

- Confirm the app URL uses HTTPS.
- Confirm the manifest is valid and reachable.
- Confirm the browser supports PWA install.
- On iPhone, use Safari; third-party browsers follow iOS restrictions.
- On Android, refresh once after the service worker has loaded.

If the icon looks cropped:

- Regenerate square app icons with safe padding.
- Confirm the manifest points to the padded icons.
- Confirm the Apple touch icon exists.

If the app opens in a browser tab instead of standalone mode:

- Confirm the manifest `display` value is `standalone`.
- Remove the old home-screen shortcut and install again after a deployment.
