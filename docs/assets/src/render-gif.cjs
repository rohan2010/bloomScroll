// Renders how-it-works.html frame by frame and encodes ../how-it-works.gif and ../how-it-works.png.
//   cd extension && node ../docs/assets/src/render-gif.cjs
// Needs Playwright's Chromium (pnpm exec playwright install chromium) and ffmpeg on PATH.
// Resolved from the working directory (extension/), where Playwright is installed.
const { chromium } = require(require.resolve("@playwright/test", { paths: [process.cwd()] }));
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FPS = Number(process.env.FPS || 25);
const here = __dirname;
const out = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bloom-gif-"));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  await page.goto("file://" + path.join(here, "how-it-works.html"));
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const n = Math.round(duration * FPS);
  for (let i = 0; i < n; i++) {
    const url = await page.evaluate((t) => window.frame(t), i / FPS);
    fs.writeFileSync(path.join(tmp, `f${String(i).padStart(4, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
  // Still for places where GIFs don't play: the moment every tile has its verdict.
  const still = await page.evaluate((t) => window.frame(t), Number(process.env.STILL || 6.3));
  await browser.close();
  const pngPath = path.join(tmp, "still.png");
  fs.writeFileSync(pngPath, Buffer.from(still.split(",")[1], "base64"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pngPath, "-vf", "scale=1440:-1:flags=lanczos", path.join(out, "how-it-works.png")]);

  const filters = `fps=${FPS},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(tmp, "f%04d.png"), "-filter_complex", filters, "-loop", "0", path.join(out, "how-it-works.gif")]);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of ["how-it-works.gif", "how-it-works.png"]) console.log(f, (fs.statSync(path.join(out, f)).size / 1e6).toFixed(2), "MB");
  console.log(`${n} frames at ${FPS} fps = ${duration}s`);
})();
