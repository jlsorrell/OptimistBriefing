import { describe, expect, it, vi } from "vitest";

import SafePreviewReporter, {
  formatPreviewTestDiagnostic,
  parsePreviewTestDiagnostics,
} from "../../../scripts/preview-e2e/safe-reporter";

const safeLine =
  "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=0 status=failed";
const externalLine =
  "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=external errorLine=0 status=failed";

describe("preview safe test reporter", () => {
  it("formats only a fully whitelisted diagnostic", () => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      errorSource: "none",
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
      errorSource: "none",
      errorLine: 0,
      status: "failed",
    })).toBe(
      `OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=${file} line=${line} errorSource=none errorLine=0 status=failed`,
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
      errorSource: "none",
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
      errorSource: "test",
      errorLine,
      status: "timedOut",
    })).toBe(
      `OPTIMIST_PREVIEW_TEST_RESULT project=mobile file=${file} line=1 errorSource=test errorLine=${errorLine} status=timedOut`,
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
      errorSource: "test",
      errorLine,
      status: "failed",
    })).toBeUndefined();
  });

  it.each([
    [1, "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=1 status=failed"],
    [90, "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=90 status=failed"],
  ])("accepts bounded fixture line %i", (errorLine, expected) => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      errorSource: "fixture",
      errorLine,
      status: "failed",
    })).toBe(expected);
  });

  it("accepts a structured external location without a line", () => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      errorSource: "external",
      errorLine: 0,
      status: "failed",
    })).toBe(externalLine);
  });

  it.each([
    ["none", 1],
    ["external", 1],
    ["test", 0],
    ["fixture", 0],
    ["fixture", 91],
    ["fixture", 1234567890123456],
  ])("rejects invalid %s and error line %i pairing", (errorSource, errorLine) => {
    expect(formatPreviewTestDiagnostic({
      project: "desktop",
      file: "tests/preview-e2e/access.spec.ts",
      line: 5,
      errorSource,
      errorLine,
      status: "failed",
    })).toBeUndefined();
  });

  it("rejects a canonical-looking line carrying a 16-digit numeric secret", () => {
    const numericSecret =
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=1234567890123456 errorSource=none errorLine=0 status=failed";

    expect(parsePreviewTestDiagnostics(numericSecret)).toEqual([]);
  });

  it.each([
    { project: "other", file: "tests/preview-e2e/access.spec.ts", line: 5, errorSource: "none", errorLine: 0, status: "failed" },
    { project: "desktop", file: "/tmp/access.spec.ts", line: 5, errorSource: "none", errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/../secret.ts", line: 5, errorSource: "none", errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access secret.spec.ts", line: 5, errorSource: "none", errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 0, errorSource: "none", errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, errorSource: "none", errorLine: -1, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, errorSource: "secret", errorLine: 0, status: "failed" },
    { project: "desktop", file: "tests/preview-e2e/access.spec.ts", line: 5, errorSource: "none", errorLine: 0, status: "retrying" },
  ])("refuses an unsafe diagnostic without echoing its fields", (input) => {
    expect(formatPreviewTestDiagnostic(input)).toBeUndefined();
  });

  it("extracts valid lines and discards unsafe or secret-bearing near matches", () => {
    const output = [
      "test title with access-token-fixture",
      safeLine,
      `${safeLine} access-token-fixture`,
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/../secret.ts line=5 errorSource=external errorLine=0 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=0 status=failed\r",
      "https://preview.example/current-login?token=access-token-fixture",
    ].join("\n");

    expect(parsePreviewTestDiagnostics(output)).toEqual([safeLine]);
  });

  it("independently reconstructs all closed error source categories", () => {
    const output = [
      safeLine,
      externalLine,
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=test errorLine=24 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=90 status=failed",
    ].join("\n");

    expect(parsePreviewTestDiagnostics(output)).toEqual(output.split("\n"));
  });

  it.each([
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorLine=0 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=secret errorLine=0 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=25 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=external errorLine=1 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=test errorLine=0 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=0 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=test errorLine=25 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=91 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=1234567890123456 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=0 status=failed secret=access-token-fixture",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=00 status=failed",
    "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=none errorLine=-1 status=failed",
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
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/responsive-accessibility.spec.ts line=34 errorSource=test errorLine=57 status=failed\n",
    );
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
    expect(write.mock.calls.flat().join(" ")).not.toContain("88");
  });

  it.each([
    [1, "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=1 status=failed\n"],
    [90, "OPTIMIST_PREVIEW_TEST_RESULT project=desktop file=tests/preview-e2e/access.spec.ts line=5 errorSource=fixture errorLine=90 status=failed\n"],
  ])("emits bounded exact fixture error line %i", (errorLine, expected) => {
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
        location: {
          file: "/repo/tests/preview-e2e/fixtures.ts",
          line: errorLine,
          column: 1,
        },
        message: "access-token-fixture",
      }],
    } as never);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expected);
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
    expect(write.mock.calls.flat().join(" ")).not.toContain("fixtures.ts");
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
    ["secret-like file", { file: "/repo/tests/preview-e2e/access-token-fixture.spec.ts", line: 6, column: 1 }, externalLine],
    ["traversal", { file: "/repo/tests/preview-e2e/../secret.ts", line: 6, column: 1 }, externalLine],
    ["same-test traversal alias", { file: "/repo/tests/preview-e2e/nested/../access.spec.ts", line: 6, column: 1 }, externalLine],
    ["cross-file", { file: "/repo/tests/preview-e2e/content.spec.ts", line: 6, column: 1 }, externalLine],
    ["fixture lookalike", { file: "/repo/tests/preview-e2e/fixtures.ts.secret", line: 6, column: 1 }, externalLine],
    ["fixture traversal alias", { file: "/repo/tests/preview-e2e/nested/../fixtures.ts", line: 6, column: 1 }, externalLine],
    ["absent location", undefined, safeLine],
  ])("classifies an unsafe or %s error location", (_name, location, expected) => {
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
    expect(write).toHaveBeenCalledWith(`${expected}\n`);
    expect(write.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
  });

  it.each([
    ["test maximum plus one", "/repo/tests/preview-e2e/access.spec.ts", 25],
    ["test 16-digit line", "/repo/tests/preview-e2e/access.spec.ts", 1234567890123456],
    ["fixture maximum plus one", "/repo/tests/preview-e2e/fixtures.ts", 91],
    ["fixture 16-digit line", "/repo/tests/preview-e2e/fixtures.ts", 1234567890123456],
  ])("suppresses an exact known source with an invalid %s", (_name, errorFile, errorLine) => {
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
        location: {
          file: errorFile,
          line: errorLine,
          column: 1,
        },
        message: "access-token-fixture",
      }],
    } as never);

    expect(write).not.toHaveBeenCalled();
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
