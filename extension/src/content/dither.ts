// "Destroyed" effect for off-topic tiles: the tile dissolves pixel by pixel in an ordered-dither
// pattern, with a bright crackling edge sweeping top to bottom. Drawn on one full-viewport canvas in
// our own shadow root, never inside YouTube's (recycled) elements.

const CELL = 5; // dither cell size in CSS pixels
const DURATION = 800;
const EDGE = 0.1; // width of the bright edge band, in threshold units

// 8x8 Bayer matrix: the classic ordered-dither threshold map (values 0..63).
const BAYER8 = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34,
  18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];

/** Cheap deterministic per-cell noise in [0, 1), so the pattern doesn't look like a grid. */
function hash(i: number, j: number, seed: number): number {
  let h = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** When cell (i, j) of a cols x rows grid dissolves, in [0, 1]: dither + noise + a top-down sweep. */
function threshold(i: number, j: number, rows: number, seed: number): number {
  const bayer = (BAYER8[(j % 8) * 8 + (i % 8)] + 0.5) / 64;
  const sweep = rows > 1 ? j / (rows - 1) : 0;
  return 0.45 * bayer + 0.25 * hash(i, j, seed) + 0.3 * sweep;
}

type Job = {
  el: Element;
  start: number;
  seed: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  /** Per-cell thresholds for a cols x rows grid, computed on the first frame (tiles don't resize mid-dissolve). */
  grid?: { cols: number; rows: number; t: Float32Array };
};

function gridFor(job: Job, cols: number, rows: number): Float32Array {
  if (job.grid?.cols === cols && job.grid.rows === rows) return job.grid.t;
  const t = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) t[j * cols + i] = threshold(i, j, rows, job.seed);
  job.grid = { cols, rows, t };
  return t;
}

const easeIn = (t: number) => t * t * (3 - 2 * t); // smoothstep

function pageBackground(): string {
  for (const node of [document.querySelector("ytd-app"), document.body, document.documentElement]) {
    if (!node) continue;
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return document.documentElement.hasAttribute("dark") ? "#0f0f0f" : "#ffffff";
}

function edgeColor(): string {
  return document.documentElement.hasAttribute("dark") ? "rgba(241, 241, 241, 0.7)" : "rgba(15, 15, 15, 0.6)";
}

class DitherLayer {
  private host?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private jobs = new Set<Job>();
  private raf = 0;
  /** Page colours, read once per run of the effect: getComputedStyle every frame forces a style pass. */
  private colors?: { bg: string; edge: string };

  /** Resolves when the tile is fully covered; the caller hides it in that same frame. */
  dissolve(el: Element): { done: Promise<void>; cancel: () => void } {
    let job!: Job;
    const done = new Promise<void>((resolve, reject) => {
      job = { el, start: performance.now(), seed: (Math.random() * 1e9) | 0, resolve, reject };
    });
    this.jobs.add(job);
    this.ensureCanvas();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    const cancel = () => {
      if (!this.jobs.delete(job)) return;
      job.reject(new Error("cancelled"));
    };
    return { done, cancel };
  }

  private ensureCanvas(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement("bloomscroll-fx");
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147482999}canvas{width:100%;height:100%;display:block}</style><canvas></canvas>`;
    this.canvas = root.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    document.documentElement.appendChild(this.host);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const canvas = this.canvas!;
    const ctx = this.ctx!;
    const dpr = devicePixelRatio || 1;
    const w = Math.ceil(innerWidth * dpr);
    const h = Math.ceil(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    const { bg, edge } = (this.colors ??= { bg: pageBackground(), edge: edgeColor() });
    for (const job of this.jobs) {
      const p = Math.min(1, (now - job.start) / DURATION);
      if (p >= 1 || !job.el.isConnected) {
        this.jobs.delete(job);
        job.resolve(); // caller hides the tile before this frame paints, so there's no flash
        continue;
      }
      const r = job.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || !r.width || !r.height) continue;
      const cols = Math.ceil(r.width / CELL);
      const rows = Math.ceil(r.height / CELL);
      // The front runs a little past 1 so the last cells clear before the job ends.
      const front = easeIn(p) * (1 + EDGE);
      const gone = new Path2D();
      const burning = new Path2D();
      const grid = gridFor(job, cols, rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const t = grid[j * cols + i];
          if (t < front - EDGE) gone.rect(r.left + i * CELL, r.top + j * CELL, CELL, CELL);
          else if (t < front) burning.rect(r.left + i * CELL, r.top + j * CELL, CELL, CELL);
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, 12);
      ctx.clip();
      ctx.fillStyle = bg;
      ctx.fill(gone);
      ctx.fillStyle = edge;
      ctx.fill(burning);
      ctx.restore();
    }
    if (this.jobs.size) this.raf = requestAnimationFrame(this.frame);
    else {
      this.host?.remove();
      this.colors = undefined; // the theme may change before the next run
    }
  };
}

export const ditherLayer = new DitherLayer();
export const DISSOLVE_MS = DURATION;
