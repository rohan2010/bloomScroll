// Off-intent categories shared by the model prompt (as choice options) and the embedding
// pre-filter (as anchors). Giving off-topic videos somewhere better to go than a single "other"
// label separated on/off-intent titles far better for both Laya and MiniLM in a 40-title eval.

/** Kept under 11 options with on-intent: Laya's English checkpoint is uncalibrated from 11 up. */
export const DISTRACTORS: Record<string, string> = {
  gaming: "video games and gameplay",
  music: "music and concerts",
  food: "cooking and food",
  sports: "sports and fitness",
  comedy: "comedy, pranks, memes and reactions",
  news: "news, politics and celebrities",
  lifestyle: "vlogs, travel and lifestyle",
  gadgets: "consumer gadget reviews and unboxing",
};

/** Every distractor that doesn't overlap a user topic (a "cooking" topic drops "food"). */
export function distractorsFor(topics: string[]): Record<string, string> {
  const words = topics.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}+#]+/u)).filter((w) => w.length >= 4);
  const overlaps = (label: string, desc: string) => {
    const text = `${label} ${desc}`.toLowerCase();
    return words.some((w) => text.includes(w) || w.includes(label));
  };
  return Object.fromEntries(Object.entries(DISTRACTORS).filter(([label, desc]) => !overlaps(label, desc)));
}
