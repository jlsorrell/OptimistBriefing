import { relative, resolve, sep } from "node:path";

import type {
  Reporter,
  TestCase,
  TestResult,
  TestStatus,
} from "@playwright/test/reporter";

const PROJECTS = new Set(["desktop", "tablet", "mobile"]);
const FILE_MAX_SOURCE_LINES = {
  "tests/preview-e2e/access.spec.ts": 24,
  "tests/preview-e2e/content.spec.ts": 400,
  "tests/preview-e2e/responsive-accessibility.spec.ts": 89,
} as const;
const FIXTURE_FILE = "tests/preview-e2e/fixtures.ts";
const FIXTURE_MAX_SOURCE_LINE = 98;
const STATUSES = new Set<TestStatus>([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
const DIAGNOSTIC_PATTERN =
  /^OPTIMIST_PREVIEW_TEST_RESULT project=(desktop|tablet|mobile) file=(tests\/preview-e2e\/(?:access\.spec\.ts|content\.spec\.ts|responsive-accessibility\.spec\.ts)) line=([1-9]\d*) errorSource=(none|test|fixture|external) errorLine=(0|[1-9]\d*) status=(passed|failed|timedOut|skipped|interrupted)$/;

type ErrorSource = "none" | "test" | "fixture" | "external";

interface PreviewTestDiagnostic {
  project: string;
  file: string;
  line: number;
  errorSource: string;
  errorLine: number;
  status: string;
}

export function formatPreviewTestDiagnostic(
  diagnostic: PreviewTestDiagnostic,
): string | undefined {
  const maximumLine = FILE_MAX_SOURCE_LINES[
    diagnostic.file as keyof typeof FILE_MAX_SOURCE_LINES
  ];
  const validErrorLocation =
    ((diagnostic.errorSource === "none" || diagnostic.errorSource === "external") &&
      diagnostic.errorLine === 0) ||
    (diagnostic.errorSource === "test" &&
      diagnostic.errorLine > 0 &&
      diagnostic.errorLine <= (maximumLine ?? 0)) ||
    (diagnostic.errorSource === "fixture" &&
      diagnostic.errorLine > 0 &&
      diagnostic.errorLine <= FIXTURE_MAX_SOURCE_LINE);
  if (
    !PROJECTS.has(diagnostic.project) ||
    maximumLine === undefined ||
    !Number.isSafeInteger(diagnostic.line) ||
    diagnostic.line <= 0 ||
    diagnostic.line > maximumLine ||
    !Number.isSafeInteger(diagnostic.errorLine) ||
    !validErrorLocation ||
    !STATUSES.has(diagnostic.status as TestStatus)
  ) {
    return undefined;
  }
  return "OPTIMIST_PREVIEW_TEST_RESULT" +
    ` project=${diagnostic.project}` +
    ` file=${diagnostic.file}` +
    ` line=${diagnostic.line}` +
    ` errorSource=${diagnostic.errorSource}` +
    ` errorLine=${diagnostic.errorLine}` +
    ` status=${diagnostic.status}`;
}

export function parsePreviewTestDiagnostics(output: string): string[] {
  const diagnostics: string[] = [];
  for (const line of output.split("\n")) {
    const match = DIAGNOSTIC_PATTERN.exec(line);
    if (match === null) continue;
    const formatted = formatPreviewTestDiagnostic({
      project: match[1]!,
      file: match[2]!,
      line: Number(match[3]),
      errorSource: match[4]!,
      errorLine: Number(match[5]),
      status: match[6]!,
    });
    if (formatted === line) diagnostics.push(formatted);
  }
  return diagnostics;
}

interface SafePreviewReporterOptions {
  rootDirectory?: string;
  write?: (text: string) => void;
}

export default class SafePreviewReporter implements Reporter {
  readonly #rootDirectory: string;
  readonly #write: (text: string) => void;

  constructor(options: SafePreviewReporterOptions = {}) {
    this.#rootDirectory = options.rootDirectory ?? process.cwd();
    this.#write = options.write ?? ((text) => process.stdout.write(text));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === test.expectedStatus) return;
    const project = test.parent.project()?.name;
    const file = relative(
      this.#rootDirectory,
      resolve(this.#rootDirectory, test.location.file),
    ).split(sep).join("/");
    const errorLocation = result.errors[0]?.location;
    let errorSource: ErrorSource = "none";
    let errorLine = 0;
    if (errorLocation !== undefined) {
      errorSource = "external";
      const errorFile = relative(
        this.#rootDirectory,
        resolve(this.#rootDirectory, errorLocation.file),
      ).split(sep).join("/");
      if (
        errorLocation.file === test.location.file &&
        errorFile === file
      ) {
        errorSource = "test";
        errorLine = errorLocation.line;
      } else if (
        errorLocation.file === resolve(this.#rootDirectory, FIXTURE_FILE) &&
        errorFile === FIXTURE_FILE
      ) {
        errorSource = "fixture";
        errorLine = errorLocation.line;
      }
    }
    const diagnostic = formatPreviewTestDiagnostic({
      project: project ?? "",
      file,
      line: test.location.line,
      errorSource,
      errorLine,
      status: result.status,
    });
    if (diagnostic !== undefined) this.#write(`${diagnostic}\n`);
  }

  printsToStdio(): boolean {
    return true;
  }
}
