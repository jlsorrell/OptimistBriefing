import { z } from "zod";

export const PREVIEW_SECTIONS = [
  "morning_brief", "research", "research_radar", "world", "technology",
  "ai_policy", "dmv", "baltimore", "forecast",
] as const;
export type PreviewSection = (typeof PREVIEW_SECTIONS)[number];

export const PREVIEW_SECTION_LABELS: Readonly<Record<PreviewSection, string>> = {
  morning_brief: "Morning brief",
  research: "Research",
  research_radar: "On the radar",
  world: "World",
  technology: "Technology",
  ai_policy: "AI policy",
  dmv: "DMV",
  baltimore: "Baltimore",
  forecast: "Forecast signals",
};

const calendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value;
  }, "must be a real YYYY-MM-DD calendar date");

const httpURL = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use HTTP or HTTPS");

const sourceRefSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  url: httpURL,
  role: z.enum(["primary", "reporting", "analysis", "opinion", "blog", "forecast"]),
}).passthrough();
const entrySchema = z.object({
  id: z.string().trim().min(1),
  section: z.enum(PREVIEW_SECTIONS),
  position: z.number().int().nonnegative(),
  selectionReasons: z.array(z.string()),
  sourceRefs: z.array(sourceRefSchema),
  summary: z.object({ title: z.string().trim().min(1) }).passthrough(),
}).passthrough();
const editionSchema = z.object({
  editionDate: calendarDate,
  entries: z.array(entrySchema).min(1),
}).passthrough();

export type PreviewSourceRef = z.infer<typeof sourceRefSchema>;
export type PreviewEntry = z.infer<typeof entrySchema>;
export type PreviewEdition = z.infer<typeof editionSchema>;

export function parsePreviewEdition(body: unknown): PreviewEdition {
  const parsed = editionSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.length === 0 ? "response" : issue.path.join(".");
  throw new TypeError(`Preview edition contract: ${path} ${issue.message}`);
}

export function formatPreviewEditionDate(editionDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${editionDate}T12:00:00.000Z`));
}

export function expectedCardSourceHosts(entries: readonly PreviewEntry[]): string[] {
  return [...new Set(entries
    .filter(({ section }) => section !== "morning_brief")
    .flatMap(({ sourceRefs }) => sourceRefs.map(({ url }) => new URL(url).hostname))
  )].sort();
}
