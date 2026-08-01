import { describe, expect, it, vi } from "vitest";

import SafePreviewReporter, {
  formatPreviewTestDiagnostic,
  parsePreviewTestDiagnostics,
} from "../../../scripts/preview-e2e/safe-reporter";

const safeLine =
  "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 status=failed";

describe("preview safe test reporter", () => {
  it("formats only a fully whitelisted diagnostic", () => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      status: "failed",
    })).toBe(safeLine);
  });

  it.each([
    { project: "other", file: "tests/preview-e2e/access.spec.ts", line: 5, status: "failed" },
    { project: "desktop", file: "/tmp/access.spec.ts", line: 5, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/../secret.ts", line: 5, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access secret.spec.ts", line: 5, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, status: "retrying" },
  ])("refuses an unsafe diagnostic without echoing its fields", (input) => {
    expect(formatPreviewTestDiagnostic(input)).toBeUndefined();
  });

  it("extracts valid lines and discards unsafe or secret-bearing near matches", () => {
    const output = [
      "test title with access-token-fixture",
      safeLine,
      `${safeLine} access-token-fixture`,
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/../secret.ts line=5 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 status=failed\r",
      "https://preview.example/current-login?token=access-token-fixture",
    ].join("\n");

    expect(parsePreviewTestDiagnostics(output)).toEqual([safeLine]);
  });

  it("emits one safe line for an unexpected result without reading arbitrary result data", () => {
    const write = vi.fn();
    const reporter = new SafePreviewReporter({
      rootDirectory: "/repo",
      write,
    });
    const test = {
      expectedStatus: "passed",
      location: {
        file: "/repo/tests/preview-e2e/access.spec.ts",
        line: 5,
        column: 1,
      },
      parent: { project: () => ({ name: "desktop" }) },
      title: "secret title access-token-fixture",
      annotations: [{ type: "secret", description: "access-token-fixture" }],
    };
    const result = {
      status: "failed",
      errors: [{ message: "access-token-fixture", stack: "secret stack" }],
      stdout: [Buffer.from("access-token-fixture")],
      stderr: [Buffer.from("secret stderr")],
      attachments: [{ name: "secret", body: Buffer.from("secret body") }],
      retry: 4,
    };

    reporter.onTestEnd(test as never, result as never);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${safeLine}\n`);
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
  });

  it("emits nothing when the result has the expected status", () => {
    const write = vi.fn();
    const reporter = new SafePreviewReporter({
      rootDirectory: "/repo",
      write,
    });

    reporter.onTestEnd({
      expectedStatus: "failed",
      location: {
        file: "/repo/tests/preview-e2e/content.spec.ts",
        line: 18,
        column: 1,
      },
      parent: { project: () => ({ name: "mobile" }) },
    } as never, {
      status: "failed",
      errors: [{ message: "secret expected failure" }],
    } as never);

    expect(write).not.toHaveBeenCalled();
  });
});
