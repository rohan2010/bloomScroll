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
  can't host), `https://www.youtube.com/*`, and `http://127.0.0.1/*`, which is your own computer, so
  the extension can reach the local Laya model without an extra prompt. `localhost` and
  `api.typesafe.ai` (Jev) are optional and requested only when you choose them in Settings.
- `setup.sh` installs Laya to start automatically at login; it listens only on `127.0.0.1`.
  `bash setup.sh --remove-autostart` turns that off.
