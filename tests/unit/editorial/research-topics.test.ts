import { describe, expect, it } from "vitest";

import { mapResearchTopicIds } from "../../../src/editorial/research-topics";

describe("mapResearchTopicIds", () => {
  it.each([
    "Recall is the bottleneck for parametric factuality",
    "Knowledge profiling for language models",
  ])("maps the configured interpretability concept: %s", (text) => {
    expect(mapResearchTopicIds([text])).toContain("alignment-interpretability");
  });
});
