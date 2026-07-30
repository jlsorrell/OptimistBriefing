import { describe, expect, it } from "vitest";

import { PIPELINE_STEPS } from "../../../src/workflow/types";
import { runCheckpointWithWorkflowStep } from "../../../src/workflow/daily-briefing-workflow";

describe("durable workflow checkpoint execution", () => {
  it.each(PIPELINE_STEPS)("rethrows an injected %s failure so the workflow can resume from that checkpoint", async (checkpoint) => {
    const invoked: string[] = [];
    const step = {
      do: async <T>(name: string, _options: unknown, operation: () => Promise<T>) => {
        invoked.push(name);
        return operation();
      },
    };

    await expect(runCheckpointWithWorkflowStep(step, checkpoint, async () => {
      throw new Error(`INJECTED_${checkpoint.toUpperCase()}_FAILURE`);
    })).rejects.toThrow(`INJECTED_${checkpoint.toUpperCase()}_FAILURE`);
    expect(invoked).toEqual([checkpoint]);
  });
});
