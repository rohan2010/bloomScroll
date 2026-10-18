# Contributing to bloomScroll

Thanks for wanting to help. bloomScroll is a small, early project, so every contribution
matters, and many of the most useful ones need no code at all.

- [Ways to help without writing code](#ways-to-help-without-writing-code)
- [What we're planning](#what-were-planning)
- [Good first contributions](#good-first-contributions)
- [Setting up for development](#setting-up-for-development)
- [How the code is organised](#how-the-code-is-organised)
- [Ground rules](#ground-rules)
- [Making a pull request](#making-a-pull-request)
- [Conduct](#conduct)

## Ways to help without writing code

**Tell us when YouTube breaks it.** YouTube changes its page layout often, and when it does,
bloomScroll quietly stops finding videos. If the popup says *No video tiles found*, or nothing gets
filtered any more, open a [**Selector broke**](https://github.com/rohan2010/bloomScroll/issues/new?template=selector-broke.yml) issue
and say which page it happened on. This is the single most valuable report.

**Tell us when it gets a video wrong.** Turn on the debug overlay in the popup, press **Copy**, and
paste the result into a [**Wrong decision**](https://github.com/rohan2010/bloomScroll/issues/new?template=wrong-decision.yml) issue,
along with your topics and what you expected. Patterns across many reports are how the prompts and
thresholds get better. Only paste what you're comfortable sharing: the report includes the titles
and channels of recent videos.

**Try it on Windows or Linux.** bloomScroll is built and tested on macOS. If you run `setup.sh` on
Linux, or on Windows with Git Bash or WSL, please report what happened, good or bad, in a
[**Bug report**](https://github.com/rohan2010/bloomScroll/issues/new?template=bug-report.yml). Even "it just worked" helps.

**Share your numbers.** Settings → **Run calibration** shows how accurate bloomScroll is on your own
answers. Sharing the before/after figures (no titles needed), with your machine and whether you use
Laya, tells us how it does beyond the test feed.

**Improve the words.** The README and the extension's text are written for people who aren't
technical. If something confused you, it will confuse others: open an issue or suggest an edit.

**Spread it.** Star the repo, or tell someone who loses evenings to YouTube.

## What we're planning

bloomScroll is an early release. This is the direction, roughly in order. None of it is promised,
and ideas are welcome.

**Next (polish and trust)**
- Work mode reworked as a stricter, optionally scheduled focus mode (e.g. weekdays 9:00–18:00).
- Tests against real, saved YouTube pages, so layout changes are caught before users notice.
- A real-world accuracy check on hundreds of labelled titles, against a target of over 90% of shown
  videos being on-topic.
- A Chrome Web Store listing, so installing doesn't need Developer mode.

**Later (lighter, faster, smarter)**
- Laya running inside the extension: no Python, no server, no terminal window.
- Smaller, compressed models that keep their accuracy.
- Apple Silicon acceleration for larger, more accurate local models.
- Learning directly from your corrections, beyond today's calibration.
- More sites: Reddit, X, LinkedIn, Hacker News, through a common site-adapter layer.
- A Firefox build.

**Experimental**
- An opt-in "feed gardener" that clicks *Not interested* on off-topic videos, so YouTube's own
  recommendations improve. Supervised, rate-limited and dry-run by default.

If you'd like to work on one of these, open an issue first so we can agree on the approach.

## Good first contributions

- **Fix a selector.** All YouTube selectors live in
  [`extension/src/content/selectors.ts`](extension/src/content/selectors.ts). See
  [Fixing a selector](#fixing-a-selector).
- **Add a real page fixture.** Save a scrubbed YouTube page into `tests/fixtures/` (steps in
  [`tests/fixtures/README.md`](tests/fixtures/README.md)) and make `pnpm test:selectors` pass on it.
- **Make `setup.sh` work on your platform.** Linux and Windows (Git Bash or WSL) are untested.
- **Write tests** for anything not covered yet, especially in the content script.
- **Wording and accessibility** in the popup, Settings, drawer and README.

Issues labelled [`good first issue`](https://github.com/rohan2010/bloomScroll/labels/good%20first%20issue) are a good place to start.

## Setting up for development

You need Node.js 20+ and Chrome, Edge or Brave. Python 3.10–3.12 (3.11 on Intel Macs) is only
needed if you work on the local Laya server.

```bash
git clone https://github.com/rohan2010/bloomScroll.git
cd bloomScroll
bash setup.sh --no-server      # or plain `bash setup.sh` for everything, incl. Laya at login
cd extension
pnpm dev                       # rebuilds extension/dist as you edit
```

Load `extension/dist` in `chrome://extensions` (Developer mode → Load unpacked). After changes,
click ↻ on bloomScroll's card **and reload your YouTube tabs**. Already-open tabs keep the old
script, which logs "Extension context invalidated" and stops quietly.

### Tests

```bash
pnpm test              # unit tests (Vitest): cascade, calibration, extraction, backends, cache
pnpm test:selectors    # extraction against tests/fixtures only
pnpm test:e2e          # builds, then runs the real extension in Playwright's Chromium
pnpm typecheck
```

The end-to-end tests serve a YouTube-shaped mock feed (`tests/e2e/feed.ts`) at
`https://www.youtube.com/` inside the test browser, and point the model at a closed port, so only
rules and the built-in model decide. They need Playwright's Chromium once:
`npx playwright install chromium`.

With Laya running (`server/start.sh`), two more checks are available:

```bash
LAYA_URL=http://127.0.0.1:8765 pnpm exec vitest run jevWire    # API contract
LAYA_URL=http://127.0.0.1:8765 pnpm exec vitest run pipeline   # end-to-end timing
```

### Fixing a selector

1. Open the broken page on YouTube in a private window, then DevTools → Elements, and find a video
   tile.
2. Update the lists in `selectors.ts`. Each list is tried in order, so add the new selector first
   and keep the old ones as fallbacks.
3. Save a scrubbed copy of the page as a fixture and add or extend a test in
   `tests/unit/extract.test.ts`.
4. Run `pnpm test:selectors`, then check the popup on real YouTube shows a sensible tile count.

## How the code is organised

```text
extension/src/content/      runs on YouTube: finds tiles, applies verdicts, dither effect,
                            Hidden drawer, Hide button, debug overlay
extension/src/background/   service worker: the decision cascade, embedder, model backends,
                            IndexedDB cache, calibration
extension/src/offscreen/    MiniLM via Transformers.js + ONNX Runtime (WASM)
extension/src/popup/        toolbar popup
extension/src/options/      Settings page, including the calibration review queue
extension/src/shared/       types, settings, messages shared by all of the above
server/                     Laya setup, start script, prompt evaluation, speed notes
tests/unit, tests/e2e       Vitest and Playwright tests; tests/fixtures holds YouTube HTML
docs/                       privacy notes and README media (with the scripts that make them)
```

How a video is decided: **rules → embeddings → model → shown by default**. The cheapest confident
stage wins, and the user's own corrections come before all of them. See
[`extension/src/background/cascade.ts`](extension/src/background/cascade.ts) and the
[How it works](README.md#how-it-works) section of the README.

## Ground rules

These keep bloomScroll trustworthy and fast. Pull requests that break them won't be merged.

1. **Private by default.** No analytics, telemetry, accounts or remote logging. The only network
   call is to the model backend the user chose (local by default), plus Jev when the user opts in
   with their own key. Models and runtimes ship inside the extension; nothing is fetched at runtime.
2. **Fail open.** If anything goes wrong, show the video. bloomScroll must never leave a feed
   blank or hide a video because it couldn't decide.
3. **All YouTube selectors in `selectors.ts`.** When YouTube changes, the fix should be one file.
4. **Never modify or remove YouTube's own elements' structure.** YouTube reuses tile elements as
   you scroll. Hide with classes and attributes; draw overlays (drawer, debug panel, Hide button,
   dither effect) in bloomScroll's own shadow roots.
5. **Measure before claiming.** Speed or accuracy changes come with numbers from the eval scripts
   (`server/eval_prompts.py`, `pnpm eval:embeddings`, the pipeline benchmark), measured in Chrome
   where it matters. The README only quotes measured figures.
6. **Respect the slowest machine.** bloomScroll targets a 2017 dual-core laptop with 8 GB of
   memory. Prefer the change that keeps it light.
7. **Write for non-technical people** in anything a user sees.

## Making a pull request

1. For anything bigger than a small fix, open an issue first and describe the plan.
2. Create a branch, make the change, and add or update tests.
3. Run `pnpm typecheck`, `pnpm test` and `pnpm test:e2e`. They must pass; CI runs the same.
4. If you changed something visible, add a before/after screenshot to the pull request.
5. If you changed speed or accuracy, include the numbers and how you measured them.
6. Keep commits focused, with a message that says *why*, not just *what*.

By contributing, you agree that your work is released under the project's [MIT license](LICENSE).

## Conduct

Be kind and assume good intent. Critique code and ideas, not people. Harassment, insults or
discrimination of any kind aren't welcome and will get you removed from the project. If something
goes wrong, open an issue or contact the maintainer through GitHub.
