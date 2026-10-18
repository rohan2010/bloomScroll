# YouTube fixtures

These files are **hand-written approximations** of YouTube's markup as of Oct 2026, trimmed to
what `extract.ts` reads. Replace them with real saved HTML when you can:

1. Open the surface on youtube.com and scroll a little so tiles render. Prefer a logged-out or
   private window: a logged-in page carries your account name, avatar and recommendations.
2. DevTools → Elements → right-click `<html>` → Copy → Copy outerHTML.
3. Paste into `home.raw.html` (or `watch.raw.html`, `search.raw.html`). `*.raw.html` is gitignored.
4. Scrub before committing. Delete every `<script>` and `<style>` block (they hold `ytcfg`,
   `VISITOR_DATA`, `DATASYNC_ID` and session tokens), plus the masthead/avatar and guide sidebar.
   Keep only the tile markup. Save the result as `home.html` etc.
5. Check it: `grep -n -i -E 'ytcfg|VISITOR_DATA|DATASYNC|SAPISID|@gmail|accounts.google' tests/fixtures/*.html`
   should print nothing.
6. Run `pnpm test:selectors` from `extension/` and update the expected values in
   `tests/unit/extract.test.ts`.

When YouTube changes its layout, save a fresh copy, watch the test fail, and fix `selectors.ts`.
