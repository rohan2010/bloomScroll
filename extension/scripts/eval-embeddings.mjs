// Measures MiniLM similarity on 40 labeled titles to pick embedShow / embedHide.
//   node scripts/eval-embeddings.mjs
// Uses the same text format as the extension: "title — channel" vs each topic, max over topics.
import { pipeline } from "@huggingface/transformers";

const TECH = ["programming","coding","software engineering","web development","computer science","Linux","open source","machine learning","AI research","data science","DevOps","cybersecurity","algorithms","databases","TypeScript","JavaScript","Python","Rust"];
const ON = [["Rust ownership in 10 minutes","Let's Get Rusty"],["How the Linux kernel boots","Low Level"],["TypeScript generics explained","Matt Pocock"],["Attention is all you need, paper walkthrough","Yannic Kilcher"],["I built a database from scratch in Go","Tsoding"],["Docker in 100 seconds","Fireship"],["Neural networks from scratch, part 3: backpropagation","Andrej Karpathy"],["System design interview: design a URL shortener","ByteByteGo"],["Arch Linux install guide 2026","Mental Outlaw"],["Why is Python so slow?","Computerphile"],["React Server Components, a deep dive","Theo - t3.gg"],["Kubernetes networking explained","TechWorld with Nana"],["Fine-tuning Llama on a single GPU","Sam Witteveen"],["Dijkstra's algorithm visualized","Reducible"],["Neovim config from zero","ThePrimeagen"],["SQL joins in 6 minutes","Web Dev Simplified"],["How hackers bypass two-factor auth","NetworkChuck"],["Building a ray tracer in C++","The Cherno"],["Git rebase vs merge","Fireship"],["New open-source AI model beats GPT on reasoning","AI Explained"]];
const OFF = [["Top 10 EPIC pranks of the year","PrankZone"],["Perfect pasta at home","Chef Mia"],["I survived 100 days in Minecraft hardcore","GamerGuy"],["Celebrity breakup drama explained","Tea Time"],["Taylor Swift - Live at Wembley full concert","TS Fan Uploads"],["$1 vs $1,000,000 hotel room","MrBeast"],["Premier League highlights: Arsenal vs Chelsea","Sky Sports"],["My morning routine as a 25 year old","Emma Vlogs"],["Funniest cat fails compilation","Daily Dose"],["Elden Ring all bosses speedrun","Distortion2"],["Gordon Ramsay makes the perfect steak","Gordon Ramsay"],["Lofi hip hop radio, beats to relax to","Lofi Girl"],["Reacting to the worst TikToks of 2026","Penguinz0"],["Full body workout, 30 minutes, no equipment","Pamela Reif"],["Breaking news: storm hits the coast","CNN"],["Fortnite new season trailer","Fortnite"],["I tried every fast food burger","Mythical Kitchen"],["Learning to surf in Bali, travel vlog","Kara and Nate"],["Stand-up comedy special, full show","Netflix Is A Joke"],["iPhone 18 unboxing and first impressions","Unbox Therapy"]];

const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
const vecs = async (texts) => (await embed(texts, { pooling: "mean", normalize: true })).tolist();
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const tiles = [...ON.map((t) => [1, ...t]), ...OFF.map((t) => [0, ...t])];
const t0 = performance.now();
const tileVecs = await vecs(tiles.map(([, t, c]) => `${t} — ${c}`));
console.log(`embedded ${tiles.length} titles in ${(performance.now() - t0).toFixed(0)} ms`);

for (const [name, fmt] of [["topic as-is", (t) => t], ["'a video about <topic>'", (t) => `a video about ${t}`]]) {
  const topicVecs = await vecs(TECH.map(fmt));
  const sims = tileVecs.map((v) => Math.max(...topicVecs.map((tv) => dot(v, tv))));
  const on = sims.slice(0, 20), off = sims.slice(20);
  const auc = on.reduce((s, a) => s + off.reduce((s2, b) => s2 + (a > b) + 0.5 * (a === b), 0), 0) / 400;
  console.log(`\n== ${name}  AUC ${auc.toFixed(3)}`);
  console.log(`   on-topic  sims: min ${Math.min(...on).toFixed(2)}  median ${on.sort()[10].toFixed(2)}  max ${Math.max(...on).toFixed(2)}`);
  console.log(`   off-topic sims: min ${Math.min(...off).toFixed(2)}  median ${off.sort()[10].toFixed(2)}  max ${Math.max(...off).toFixed(2)}`);
  console.log("   show>=  hide<=   shown-on shown-off | hidden-on hidden-off | to model");
  for (const [show, hide] of [[0.55, 0.2], [0.5, 0.2], [0.45, 0.15], [0.4, 0.15], [0.45, 0.2], [0.4, 0.2], [0.35, 0.15]]) {
    const so = on.filter((s) => s >= show).length, sf = off.filter((s) => s >= show).length;
    const ho = on.filter((s) => s <= hide).length, hf = off.filter((s) => s <= hide).length;
    console.log(`   ${show.toFixed(2)}    ${hide.toFixed(2)}      ${String(so).padStart(2)}       ${String(sf).padStart(2)}     |    ${String(ho).padStart(2)}        ${String(hf).padStart(2)}    |  ${40 - so - sf - ho - hf}/40`);
  }
  const ranked = sims.map((s, i) => [s, tiles[i]]).sort((a, b) => b[0] - a[0]);
  console.log("   highest off-topic: " + ranked.filter(([, t]) => !t[0]).slice(0, 3).map(([s, t]) => `${t[1].slice(0, 28)} ${s.toFixed(2)}`).join("; "));
  console.log("   lowest on-topic:   " + ranked.filter(([, t]) => t[0]).slice(-3).map(([s, t]) => `${t[1].slice(0, 28)} ${s.toFixed(2)}`).join("; "));
}

// --- margin scoring: max sim to topics minus max sim to off-topic anchors ---
const DISTRACTORS = { gaming: "video games and gameplay", music: "music and concerts", food: "cooking and food", sports: "sports and fitness", comedy: "comedy, pranks, memes and reactions", news: "news, politics and celebrities", lifestyle: "vlogs, travel and lifestyle", gadgets: "consumer gadget reviews and unboxing" };
const EXTRA = ["Docker","Kubernetes","Git","Vim and Neovim","C and C++","Go programming","large language models","neural networks","system design","computer graphics","hacking","cloud computing"];
const anchorVecs = await vecs(Object.values(DISTRACTORS));
for (const [name, topics] of [["margin, built-in topics", TECH], ["margin, + specific tech topics", [...TECH, ...EXTRA]], ["max-sim, + specific tech topics", null]]) {
  const tv = await vecs(topics ?? [...TECH, ...EXTRA]);
  const scores = tileVecs.map((v) => Math.max(...tv.map((t) => dot(v, t))) - (topics ? Math.max(...anchorVecs.map((a) => dot(v, a))) : 0));
  const on = scores.slice(0, 20), off = scores.slice(20);
  const auc = on.reduce((s, a) => s + off.reduce((s2, b) => s2 + (a > b) + 0.5 * (a === b), 0), 0) / 400;
  const sorted = (xs) => [...xs].sort((a, b) => a - b);
  console.log(`\n== ${name}  AUC ${auc.toFixed(3)}`);
  console.log(`   on:  min ${sorted(on)[0].toFixed(2)}  max ${sorted(on)[19].toFixed(2)}    off: min ${sorted(off)[0].toFixed(2)}  max ${sorted(off)[19].toFixed(2)}`);
  // widest error-free zones: show above max(off), hide below min(on)
  const showAt = sorted(off)[19] + 0.02, hideAt = sorted(on)[0] - 0.02;
  const so = on.filter((s) => s >= showAt).length, hf = off.filter((s) => s <= hideAt).length;
  console.log(`   error-free with 0.02 margin: show >= ${showAt.toFixed(2)} (${so} on), hide <= ${hideAt.toFixed(2)} (${hf} off)  -> to model ${40 - so - hf}/40`);
}
