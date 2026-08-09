Vendored from the ffmpeg.wasm project so the app stays self-contained (no
runtime CDN dependency, no server-side change):

- `ffmpeg.js`, `814.ffmpeg.js` — package `@ffmpeg/ffmpeg` (MIT)
- `ffmpeg-core.js`, `ffmpeg-core.wasm` — package `@ffmpeg/core` (single-thread
  build; the wrapper is MIT, the compiled FFmpeg binary itself carries
  FFmpeg's own LGPL/GPL terms because libx264 is built in)

Not modified beyond the file names. See the respective npm packages for the
full license text and source.
