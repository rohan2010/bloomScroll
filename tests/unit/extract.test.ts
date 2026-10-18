import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractTiles, parseDuration, surfaceFor, videoIdFromHref } from "../../extension/src/content/extract";

function load(name: string): Document {
  const html = readFileSync(join(__dirname, "../fixtures", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("helpers", () => {
  it("parses video ids", () => {
    expect(videoIdFromHref("/watch?v=abc123XYZ_-&t=3")).toEqual({ videoId: "abc123XYZ_-", isShort: false });
    expect(videoIdFromHref("https://www.youtube.com/shorts/shortVid0004")).toEqual({ videoId: "shortVid0004", isShort: true });
    expect(videoIdFromHref("/playlist?list=PL1")).toBeNull();
    expect(videoIdFromHref(null)).toBeNull();
  });

  it("parses durations", () => {
    expect(parseDuration(" 10:42 ")).toBe(642);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("SHORTS")).toBeUndefined();
    expect(parseDuration("42")).toBeUndefined();
  });

  it("maps paths to surfaces", () => {
    expect(surfaceFor("/")).toBe("home");
    expect(surfaceFor("/results")).toBe("search");
    expect(surfaceFor("/watch")).toBe("sidebar");
    expect(surfaceFor("/@somechannel/videos")).toBeNull();
  });
});

describe("home fixture", () => {
  const tiles = extractTiles(load("home.html"), "home").map((t) => t.tile);

  it("finds classic and lockup tiles, skipping lazy, ad and nested tiles", () => {
    expect(tiles.map((t) => t.videoId)).toEqual(["rustOwn0001", "prank000002"]);
  });

  it("reads classic tile fields", () => {
    expect(tiles[0]).toEqual({
      videoId: "rustOwn0001",
      title: "Rust ownership in 10 minutes",
      channel: "Let's Get Rusty",
      channelId: "@letsgetrusty",
      durationSec: 642,
      isShort: false,
      surface: "home",
    });
  });

  it("reads lockup tile fields and collapses whitespace", () => {
    expect(tiles[1]).toMatchObject({
      title: "Top 10 EPIC pranks of the year",
      channel: "PrankZone",
      channelId: "UCprankChannel01",
      durationSec: 3723,
    });
  });
});

describe("watch fixture (sidebar)", () => {
  const tiles = extractTiles(load("watch.html"), "sidebar").map((t) => t.tile);

  it("scans only the sidebar, not the stale home page", () => {
    expect(tiles.map((t) => t.videoId)).toEqual(["linuxKern05", "cookPasta06"]);
  });

  it("reads compact and lockup sidebar tiles", () => {
    expect(tiles[0]).toMatchObject({ title: "How the Linux kernel boots", channel: "Low Level", durationSec: 1500, surface: "sidebar" });
    expect(tiles[1]).toMatchObject({ title: "Perfect pasta at home", channel: "Chef Mia", channelId: undefined });
  });
});

describe("search fixture", () => {
  const tiles = extractTiles(load("search.html"), "search").map((t) => t.tile);

  it("finds videos and marks shorts", () => {
    expect(tiles.map((t) => [t.videoId, t.isShort])).toEqual([
      ["tsGenerics7", false],
      ["shortSrch08", true],
    ]);
    expect(tiles[0]).toMatchObject({ title: "TypeScript generics explained", channel: "Matt Pocock", durationSec: 495 });
    expect(tiles[1].durationSec).toBeUndefined();
  });
});
