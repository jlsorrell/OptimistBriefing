import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TEMP_PREFIX } from "../../../scripts/preview-e2e/environment";
import {
  capturePreviewAccessState,
  createPreviewSignalHandler,
  createPreviewTempDirectory,
  removePreviewTempDirectory,
} from "../../../scripts/preview-e2e/node-runtime";

const baseURL = "https://optimist-briefing-preview.optimistindustries.workers.dev";
const temporaryParents: string[] = [];

async function createTemporaryParent(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "preview-e2e-node-runtime-test-"));
  temporaryParents.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryParents.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("preview E2E Node runtime", () => {
  it("creates the authentication directory with mode 0700", async () => {
    const parent = await createTemporaryParent();

    const directory = await createPreviewTempDirectory(parent);

    expect(directory).toMatch(new RegExp(`${PREVIEW_TEMP_PREFIX}.+`));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("writes protected storage state with mode 0600", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(async ({ path }: { path: string }) => {
        await writeFile(path, "{}", { mode: 0o666 });
      }),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch: vi.fn().mockResolvedValue(browser) },
    );

    expect((await stat(storageStatePath)).mode & 0o777).toBe(0o600);
    await expect(readFile(storageStatePath, "utf8")).resolves.toBe("{}");
  });

  it("rejects direct callers' unsafe origin and storage path before launching Chromium", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const launch = vi.fn();

    await expect(capturePreviewAccessState(
      {
        baseURL: "https://example.com/current-login",
        storageStatePath: join(tempDirectory, "storage-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview E2E may only target the isolated preview origin",
    });
    await expect(capturePreviewAccessState(
      {
        baseURL,
        storageStatePath: join(tempDirectory, "other-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview storage state must be the protected temporary file",
    });

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects unexpected main-frame navigation without exposing its URL and detaches the listener", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const unexpectedFrame = { url: () => "https://example.com/current-login" };
    let navigationListener: ((frame: { url(): string }) => void) | undefined;
    const page = {
      on: vi.fn((_event, listener) => { navigationListener = listener; }),
      off: vi.fn(),
      mainFrame: vi.fn(() => unexpectedFrame),
      goto: vi.fn(async () => { navigationListener!(unexpectedFrame); }),
      waitForURL: vi.fn(),
      waitForFunction: vi.fn(),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath: join(tempDirectory, "storage-state.json") },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toMatchObject({ message: "Authentication left the approved origins" });

    expect(page.off).toHaveBeenCalledWith("framenavigated", navigationListener);
  });

  it("redacts Playwright navigation failures to a generic retry error", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockRejectedValue(new Error(`${baseURL}/current-login timed out`)),
      waitForURL: vi.fn(),
      waitForFunction: vi.fn(),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath: join(tempDirectory, "storage-state.json") },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toMatchObject({
      message: "Preview authentication did not complete; retry the command.",
    });
  });

  it("removes only exact-prefix directories under the supplied temporary parent", async () => {
    const parent = await createTemporaryParent();
    const allowedDirectory = join(parent, `${PREVIEW_TEMP_PREFIX}cleanup`);
    const unrelatedDirectory = join(parent, "unrelated");
    await mkdir(allowedDirectory);
    await mkdir(unrelatedDirectory);

    await removePreviewTempDirectory(allowedDirectory, parent);

    await expect(stat(allowedDirectory)).rejects.toThrow();
    await expect(removePreviewTempDirectory(unrelatedDirectory, parent)).rejects.toThrow(
      "Refusing unsafe preview cleanup target",
    );
    await expect(stat(unrelatedDirectory)).resolves.toBeDefined();
  });

  it("cleans up before relaying a termination signal", async () => {
    const order: string[] = [];
    const handler = createPreviewSignalHandler(
      "SIGTERM",
      async () => { order.push("cleanup"); },
      (signal) => { order.push(`relay:${signal}`); },
    );

    await handler();

    expect(order).toEqual(["cleanup", "relay:SIGTERM"]);
  });
});
