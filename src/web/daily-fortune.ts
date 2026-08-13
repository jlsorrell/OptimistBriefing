export type FortuneTone =
  | "silly"
  | "creepy"
  | "cryptic"
  | "bizarre"
  | "profound"
  | "encouraging"
  | "sweet";

export type DailyFortune = {
  tone: FortuneTone;
  text: string;
};

const TONES: readonly FortuneTone[] = [
  "silly",
  "creepy",
  "cryptic",
  "bizarre",
  "profound",
  "encouraging",
  "sweet",
];

const FORTUNES: Record<FortuneTone, readonly string[]> = {
  silly: [
    "A pigeon has mistaken you for management. Act natural.",
    "Your left sock knows more than it is saying.",
    "Today's shortcut is wearing a tiny hat.",
    "The moon misplaced your receipt. Proceed anyway.",
    "A snack will solve a problem you have been overthinking.",
    "The universe has put you on hold. Enjoy the music.",
    "Avoid arguing with furniture before noon.",
    "Someone will compliment your handwriting, spiritually speaking.",
  ],
  creepy: [
    "The hallway remembers a door that was never there.",
    "If you hear your name in an empty room, it may only be tomorrow practicing.",
    "Something under the bed has finally decided to root for you.",
    "The mirror will be polite today. Return the favor.",
    "One of the shadows is yours. The other is learning.",
    "The house settles at night. Occasionally, it also takes notes.",
    "A forgotten password still dreams of being useful.",
    "Do not worry about the footsteps; they are several decisions behind you.",
  ],
  cryptic: [
    "The third answer belongs to the question you have not asked.",
    "Carry the key, but leave the lock where it is.",
    "When the blue cup is empty, the message is complete.",
    "North is a habit, not a promise.",
    "The quietest number in the room is waiting to be noticed.",
    "What returns without leaving will point the way.",
    "Today, the comma is more important than the sentence.",
    "The map is accurate; the destination has moved.",
  ],
  bizarre: [
    "At precisely no particular time, a cucumber will become relevant.",
    "Your next good idea is disguised as a municipal fountain.",
    "A small bureaucracy of moths has approved your application.",
    "The weather inside a spoon favors bold decisions.",
    "Three invisible geese have formed a committee in your honor.",
    "The elevator to nowhere is temporarily stopping on your floor.",
    "A lemon in another timezone believes in you.",
    "Reality may ask you to hold its coat.",
  ],
  profound: [
    "A life changes quietly before it changes visibly.",
    "Attention is the shape your days eventually take.",
    "The path becomes yours when you stop asking it to resemble someone else's.",
    "Not every closed door is a verdict; some are simply walls.",
    "What you practice noticing becomes the world you inhabit.",
    "Certainty is often just a story that arrived early.",
    "You do not need to finish becoming before you begin.",
    "The smallest honest choice can reorganize an entire life.",
  ],
  encouraging: [
    "You are closer than yesterday can measure.",
    "Begin with the part that feels almost possible.",
    "Your courage does not need to be loud to count.",
    "A difficult hour is not a difficult life.",
    "Let the next small step be enough.",
    "You have survived every version of uncertainty that brought you here.",
    "There is room today for both doubt and progress.",
    "Trust the part of you that kept showing up.",
  ],
  sweet: [
    "Someone is glad you exist in a way they have never quite said.",
    "A gentle moment is already making its way toward you.",
    "May you find something today that feels like being remembered.",
    "Your kindness has traveled farther than you know.",
    "There is a place in the world made warmer by your arrival.",
    "The day has saved one soft surprise especially for you.",
    "You deserve a happiness that does not need defending.",
    "Somewhere, a future memory is waiting to become dear to you.",
  ],
};

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

function calendarDay(editionDate: string): number {
  const [year, month, day] = editionDate.split("-").map(Number);
  return Math.floor(
    Date.UTC(year!, month! - 1, day!) / MILLISECONDS_PER_DAY,
  );
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

export function dailyFortuneForDate(editionDate: string): DailyFortune {
  const day = calendarDay(editionDate);
  const tone = TONES[(day + 1) % TONES.length]!;
  const options = FORTUNES[tone];
  const text = options[stableHash(editionDate) % options.length]!;
  return { tone, text };
}
