import type { EditionSection } from "../contracts/editorial";
import type {
  SectionBudgets,
  Shortlist,
} from "../editorial/shortlist";

export type MorningSelection = {
  id: string;
  section: EditionSection;
};

function selectionFor(
  candidate: Shortlist["rankedMorningCandidates"][number],
): MorningSelection {
  return "representativeItem" in candidate
    ? { id: candidate.id, section: candidate.primarySection }
    : { id: candidate.id, section: "research" };
}

function ids(values: readonly { id: string }[]): ReadonlySet<string> {
  return new Set(values.map(({ id }) => id));
}

export function assembleResearchFirstMorning(
  selected: Shortlist,
  budgets: Pick<SectionBudgets, "morningBrief" | "featuredResearch">,
): MorningSelection[] {
  const maximum = Math.max(0, budgets.morningBrief);
  const result: MorningSelection[] = [];
  const selectedIds = new Set<string>();
  const ranked = selected.rankedMorningCandidates.map(selectionFor);
  const nonlocalIds = ids([
    ...selected.world,
    ...selected.technology,
    ...selected.aiPolicy,
  ]);
  const localIds = ids([...selected.dmv, ...selected.baltimore]);

  const admit = (candidate: MorningSelection | undefined): void => {
    if (
      candidate === undefined ||
      result.length >= maximum ||
      selectedIds.has(candidate.id)
    ) return;
    result.push(candidate);
    selectedIds.add(candidate.id);
  };

  for (const item of selected.researchFeatured.slice(
    0,
    Math.min(budgets.featuredResearch, maximum),
  )) {
    admit({ id: item.id, section: "research" });
  }
  admit(ranked.find((candidate) => nonlocalIds.has(candidate.id)));
  admit(ranked.find((candidate) => localIds.has(candidate.id)));
  for (const candidate of ranked) admit(candidate);

  return result;
}
