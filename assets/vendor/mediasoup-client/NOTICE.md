Vendored from `mediasoup-client` (npm, version 3.22.0, ISC-Lizenz) so die
Bildschirmuebertragung ohne Bundler und ohne Laufzeit-CDN auskommt - gleiches
Vorgehen wie bei `assets/vendor/ffmpeg`.

`mediasoup-client.min.js` ist mit esbuild aus `mediasoup-client/lib/index.js`
zu einem einzigen IIFE-Bundle gebaut (`--bundle --format=iife
--global-name=mediasoupClient --platform=browser --minify`), unveraendert
sonst. Stellt im Browser `window.mediasoupClient.Device` bereit. Siehe das
npm-Paket fuer den vollen Lizenztext und Quellcode.

Neu bauen: `npm install mediasoup-client@3 esbuild && npx esbuild
node_modules/mediasoup-client/lib/index.js --bundle --format=iife
--global-name=mediasoupClient --platform=browser --minify
--outfile=mediasoup-client.min.js`
