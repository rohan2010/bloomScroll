# bloomScroll

Open-source, local-first browser extension that hides off-intent YouTube videos and keeps only
tech content plus the topics and channels you choose. Nothing leaves your machine by default.

> Status: pre-release (weekend 1 of the MVP). Rules, channel lists, UI cleanup, the Hidden drawer
> and the Laya client are in. The embedding pre-filter and focus-mode schedule are next.

## How it decides

Each video tile goes through a cascade; the cheapest confident stage wins:

1. **Rules**: blocklist, allowlist, Shorts, topic named in the title (show-only).
2. **Embeddings**: MiniLM similarity to your topics (coming in weekend 2).
3. **Model**: Laya via a local `/v1/systemone` server.
4. **Fallback**: opt-in Jev with your own key, only when the model is unsure (weekend 3).

If no model answers, tiles are shown, never stuck hidden.

## Develop

Requires Node 20+, pnpm and Chrome (or Edge/Brave).

```bash
cd extension
pnpm install
pnpm dev            # builds to extension/dist with hot reload
pnpm test           # unit tests (Vitest)
pnpm test:selectors # extraction against tests/fixtures
pnpm build          # production build
```

Then open `chrome://extensions`, enable Developer mode, **Load unpacked** → `extension/dist`.

For the local model, see [`server/README.md`](server/README.md), then set the backend URL in the
extension's Options (default `http://127.0.0.1:8765`) and click Save to grant access.

## Layout

```text
extension/src/content/     selectors.ts (ALL YouTube selectors), extract, hide + drawer, observers
extension/src/background/  cascade, backends/ (Jev wire API), IndexedDB cache
extension/src/popup/       focus-mode switcher, tile counts
extension/src/options/     topics, channel lists, backend, data export/delete
tests/                     fixtures + Vitest unit tests
server/                    laya-serve setup
```

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md). Short version: no accounts, no analytics, default backend is
`127.0.0.1`.

## Credits

Laya, Transformers.js, jev-ultrafast.

MIT licensed.
