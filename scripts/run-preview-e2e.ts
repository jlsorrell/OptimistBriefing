import { runPreviewHarness } from "./preview-e2e/harness";
import { createNodePreviewHarnessDependencies } from "./preview-e2e/node-runtime";

process.exitCode = await runPreviewHarness(
  process.env,
  createNodePreviewHarnessDependencies(),
);
