import { describe, expect, it, vi } from "vitest";

import SafePreviewReporter, {
  formatPreviewTestDiagnostic,
  parsePreviewTestDiagnostics,
} from "../../../scripts/preview-e2e/safe-reporter";

const safeLine =
  "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=0 status=failed";

describe("preview safe test reporter", () => {
  it("formats only a fully whitelisted diagnostic", () => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      errorLine: 0,
      status: "failed",
    })).toBe(safeLine);
  });

  it.each([
    ["tests/preview-e2e/access.spec.ts", 1],
    ["tests/preview-e2e/access.spec.ts", 24],
    ["tests/preview-e2e/content.spec.ts", 1],
    ["tests/preview-e2e/content.spec.ts", 65],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 1],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 89],
  ])("accepts %s source line %i", (file, line) => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file,
      line,
      errorLine: 0,
      status: "failed",
    })).toBe(
      `OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=${file} line=${line} errorLine=0 status=failed`,
    );
  });

  it.each([
    ["tests/preview-e2e/access.spec.ts", 25],
    ["tests/preview-e2e/content.spec.ts", 66],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 90],
    ["tests/preview-e2e/access.spec.ts", 65],
    ["tests/preview-e2e/content.spec.ts", 89],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", Number.MAX_SAFE_INTEGER],
  ])("rejects %s source line %i when it is out of range", (file, line) => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file,
      line,
      errorLine: 0,
      status: "failed",
    })).toBeUndefined();
  });

  it.each([
    ["tests/preview-e2e/access.spec.ts", 1],
    ["tests/preview-e2e/access.spec.ts", 24],
    ["tests/preview-e2e/content.spec.ts", 1],
    ["tests/preview-e2e/content.spec.ts", 65],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 1],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 89],
  ])("accepts bounded error line for %s at %i", (file, errorLine) => {
    expect(formatPreviewTestDiagnostic({
      project: "mobile",
      file,
      line: 1,
      errorLine,
      status: "timedOut",
    })).toBe(
      `OPTIMIST_PREVIEW_TEST_RESULT project=mobile file=${file} line=1 errorLine=${errorLine} status=timedOut`,
    );
  });

  it.each([
    ["tests/preview-e2e/access.spec.ts", 25],
    ["tests/preview-e2e/content.spec.ts", 66],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 90],
    ["tests/preview-e2e/access.spec.ts", 65],
    ["tests/preview-e2e/content.spec.ts", 89],
    ["tests/preview-e2e/responsive-accessibility.spec.ts", 1234567890123456],
  ])("rejects unsafe error line for %s at %i", (file, errorLine) => {
    expect(formatPreviewTestDiagnostic({
      project: "mobile",
      file,
      line: 1,
      errorLine,
      status: "failed",
    })).toBeUndefined();
  });

  it("rejects a canonical-looking line carrying a 16-digit numeric secret", () => {
    const numericSecret =
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=1234567890123456 errorLine=0 status=failed";

    expect(parsePreviewTestDiagnostics(numericSecret)).toEqual([]);
  });

  it.each([
    { project: "other", file: "tests/preview-e2e/access.spec.ts", line: 5, errorLine: 0, status: "failed" },
    { project: "desktop", file: "/tmp/access.spec.ts", line: 5, errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/../secret.ts", line: 5, errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access secret.spec.ts", line: 5, errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 0, errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, errorLine: -1, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, errorLine: 0, status: "retrying" },
  ])("refuses an unsafe diagnostic without echoing its fields", (input) => {
    expect(formatPreviewTestDiagnostic(input)).toBeUndefined();
  });

  it("extracts valid lines and discards unsafe or secret-bearing near matches", () => {
    const output = [
      "test title with access-token-fixture",
      safeLine,
      `${safeLine} access-token-fixture`,
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/../secret.ts line=5 errorLine=0 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=0 status=failed\r",
      "https://preview.example/current-login?token=access-token-fixture",
    ].join("\n");

    expect(parsePreviewTestDiagnostics(output)).toEqual([safeLine]);
  });

  it.each([
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=25 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=1234567890123456 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=0 status=failed secret=access-token-fixture",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=00 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=-1 status=failed",
  ])("rejects malformed or unsafe child diagnostic %s", (output) => {
    expect(parsePreviewTestDiagnostics(output)).toEqual([]);
  });

  it("emits the first same-file bounded error location without reading error content", () => {
    const write = vi.fn();
    const reporter = new SafePreviewReporter({
      rootDirectory: "/repo",
      write,
    });
    const test = {
      expectedStatus: "passed",
      location: {
        file: "/repo/tests/preview-e2e/responsive-accessibility.spec.ts",
        line: 34,
        column: 3,
      },
      parent: { project: () => ({ name: "tablet" }) },
    };
    const result = {
      status: "failed",
      errors: [
        {
          location: {
            file: "/repo/tests/preview-e2e/responsive-accessibility.spec.ts",
            line: 57,
            column: 7,
          },
          get message(): never {
            throw new Error("message was read");
          },
          get stack(): never {
            throw new Error("stack was read");
          },
          get snippet(): never {
            throw new Error("snippet was read");
          },
          get value(): never {
            throw new Error("value was read");
          },
          get cause(): never {
            throw new Error("cause was read");
          },
        },
        {
          location: {
            file: "/repo/tests/preview-e2e/responsive-accessibility.spec.ts",
            line: 88,
            column: 1,
          },
        },
      ],
    };

    reporter.onTestEnd(test as never, result as never);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/responsive-accessibility.spec.ts line=34 errorLine=57 status=failed\n",
    );
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
    expect(write.mock.calls.flat().join(" ")).not.toContain("88");
  });

  it("uses only the first error when its location is absent", () => {
    const write = vi.fn();
    const reporter = new SafePreviewReporter({
      rootDirectory: "/repo",
      write,
    });

    reporter.onTestEnd({
      expectedStatus: "passed",
      location: {
        file: "/repo/tests/preview-e2e/access.spec.ts",
        line: 5,
        column: 1,
      },
      parent: { project: () => ({ name: "desktop" }) },
    } as never, {
      status: "failed",
      errors: [
        { message: "access-token-fixture" },
        {
          location: {
            file: "/repo/tests/preview-e2e/access.spec.ts",
            line: 6,
            column: 1,
          },
        },
      ],
    } as never);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${safeLine}\n`);
  });

  it.each([
    ["secret-like file", { file: "/repo/tests/preview-e2e/access-token-fixture.spec.ts", line: 6, column: 1 }],
    ["traversal", { file: "/repo/tests/preview-e2e/../secret.ts", line: 6, column: 1 }],
    ["same-file traversal alias", { file: "/repo/tests/preview-e2e/nested/../access.spec.ts", line: 6, column: 1 }],
    ["cross-file", { file: "/repo/tests/preview-e2e/content.spec.ts", line: 6, column: 1 }],
    ["maximum plus one", { file: "/repo/tests/preview-e2e/access.spec.ts", line: 25, column: 1 }],
    ["16-digit line", { file: "/repo/tests/preview-e2e/access.spec.ts", line: 1234567890123456, column: 1 }],
    ["absent location", undefined],
  ])("uses errorLine=0 for an unsafe or %s error location", (_name, location) => {
    const write = vi.fn();
    const reporter = new SafePreviewReporter({
      rootDirectory: "/repo",
      write,
    });

    reporter.onTestEnd({
      expectedStatus: "passed",
      location: {
        file: "/repo/tests/preview-e2e/access.spec.ts",
        line: 5,
        column: 1,
      },
      parent: { project: () => ({ name: "desktop" }) },
    } as never, {
      status: "failed",
      errors: [{
        location,
        message: "access-token-fixture",
        stack: "secret stack",
      }],
    } as never);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${safeLine}\n`);
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
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
