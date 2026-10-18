// Renders the bloomScroll flower into the toolbar / store icon sizes Chrome wants.
//   node scripts/make-icons.mjs   (needs Playwright's Chromium: npx playwright install chromium)
import pw from "@playwright/test"; // CommonJS package, ESM project
import { mkdirSync } from "node:fs";

const { chromium } = pw;
const SIZES = [16, 32, 48, 128];
const OUT = new URL("../public/icons/", import.meta.url).pathname;

// Same 5-petal flower as the popup header. Small sizes get fatter petals and no ring so they
// stay legible at 16 px.
const svg = (size) => {
  const small = size <= 32;
  const rx = small ? 5.2 : 4.4;
  const ry = small ? 7 : 6.8;
  const petals = [0, 72, 144, 216, 288].map((a) => `<ellipse cx="16" cy="8.6" rx="${rx}" ry="${ry}" transform="rotate(${a} 16 16)"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
    <g fill="#2fae6a">${petals}</g>
    <circle cx="16" cy="16" r="${small ? 4.4 : 4}" fill="#0f2a1c"/>
    ${small ? "" : '<circle cx="16" cy="16" r="2" fill="#7be0a8"/>'}
  </svg>`;
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.locator("svg").screenshot({ path: `${OUT}icon-${size}.png`, omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
