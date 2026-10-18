import { OFF_TITLES, ON_TITLES } from "../unit/titles";

/** A YouTube-shaped home feed (same markup extract.ts reads) built from the 40 labeled titles. */
export function homeFeedHtml(): string {
  // Interleave so on- and off-topic tiles sit next to each other, as on a real feed.
  const titles = ON_TITLES.flatMap((t, i) => [{ t, on: true, i }, { t: OFF_TITLES[i], on: false, i }]);
  const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const tiles = titles
    .map(({ t: [title, channel], on, i }) => {
      // 11 characters like a real id, unique per tile: "n" on-topic, "f" off-topic.
      const id = `${on ? "n" : "f"}${String(i).padStart(10, "0")}`;
      return `
      <ytd-rich-item-renderer>
        <div id="content"><ytd-rich-grid-media>
          <a id="thumbnail" href="/watch?v=${id}"><div class="thumb" style="background:hsl(${hue(title)} 45% 55%)">
            <ytd-thumbnail-overlay-time-status-renderer><span id="text">${(i % 50) + 3}:${String((i * 7) % 60).padStart(2, "0")}</span></ytd-thumbnail-overlay-time-status-renderer>
          </div></a>
          <div id="details">
            <h3><a id="video-title-link" href="/watch?v=${id}" title="${title}"><yt-formatted-string id="video-title">${title}</yt-formatted-string></a></h3>
            <ytd-channel-name><a href="/@${channel.replace(/\W+/g, "").toLowerCase()}">${channel}</a></ytd-channel-name>
          </div>
        </ytd-rich-grid-media></div>
      </ytd-rich-item-renderer>`;
    })
    .join("");
  return `<!doctype html><html dark><head><meta charset="utf-8"><title>YouTube</title><style>
    body { margin: 0; background: #0f0f0f; color: #f1f1f1; font: 14px Roboto, system-ui, sans-serif; }
    #contents { display: flex; flex-wrap: wrap; gap: 0; padding: 24px 12px; }
    ytd-rich-item-renderer { display: block; width: calc(25% - 16px); margin: 0 8px 28px; }
    .thumb { aspect-ratio: 16/9; border-radius: 12px; position: relative; }
    #text { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.8); color: #fff; font-size: 12px; padding: 1px 4px; border-radius: 4px; }
    h3 { margin: 10px 0 4px; font-size: 15px; line-height: 1.35; } a { color: inherit; text-decoration: none; }
    ytd-channel-name { color: #aaa; font-size: 13px; }
  </style></head><body><ytd-app><ytd-browse page-subtype="home"><ytd-rich-grid-renderer><div id="contents">${tiles}</div></ytd-rich-grid-renderer></ytd-browse></ytd-app></body></html>`;
}
