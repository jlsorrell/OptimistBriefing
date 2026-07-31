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
    const parent = await createTemporaryParent();
    const storageStatePath = join(parent, "storage-state.json");
    const frame = {};
    const page = {
      on: vi.fn(),
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
