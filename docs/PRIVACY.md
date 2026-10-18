# Privacy

- No analytics, accounts or remote logging.
- The default model backend is `127.0.0.1`; nothing leaves the machine.
- The embedding model (MiniLM) and its WebAssembly runtime ship inside the extension and run
  locally. Nothing is downloaded at runtime.
- The extension only reads visible text (title, channel, duration) from YouTube tiles. No screenshots.
- Jev fallback is opt-in, uses your own key, and is labeled in the UI. When enabled it sends video
  titles and channel names to TypeSafe.
- Settings live in `chrome.storage.local`. Your corrections and calibration answers, and cached
  decisions (with each video's title and channel, kept 14 days so Settings can offer them for
  review), live in the browser's IndexedDB. Settings has one-click export and delete.
- Required permissions: `storage`, `offscreen` (to run the embedding model, which a service worker
  can't host) and `https://www.youtube.com/*`. Model backend hosts
  (`127.0.0.1`, `localhost`, `api.typesafe.ai`) are optional and requested only when you save a
  backend URL in Options.
