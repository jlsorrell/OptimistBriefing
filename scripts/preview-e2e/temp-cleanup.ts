import { randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  PREVIEW_TEMP_PREFIX,
  assertProtectedTemporaryDirectory,
} from "./environment";

export interface PreviewTempDirectoryOwnership {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export interface PreviewCleanupOptions {
  beforeQuarantineRename?: (
    source: string,
    quarantineEntry: string,
  ) => void | Promise<void>;
  afterQuarantineRename?: (
    source: string,
    quarantineEntry: string,
  ) => void | Promise<void>;
}

export interface PreviewSyncCleanupOptions {
  beforeQuarantineRename?: (
    source: string,
    quarantineEntry: string,
  ) => void;
}

interface PreviewExitEventSource {
  on(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

interface QuarantineState {
  root: string;
  entry: string;
  device: number;
  inode: number;
  mode: number;
  phase: "created" | "quarantined" | "entry-removed";
}

const quarantineStates = new WeakMap<PreviewTempDirectoryOwnership, QuarantineState>();

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertOwnedPath(ownership: PreviewTempDirectoryOwnership): string {
  const candidate = resolve(ownership.path);
  if (
    dirname(candidate) !== resolve(tmpdir()) ||
    !basename(candidate).startsWith(PREVIEW_TEMP_PREFIX) ||
    (ownership.mode & constants.S_IFMT) !== constants.S_IFDIR ||
    (ownership.mode & 0o777) !== 0o700
  ) {
    throw new Error("Refusing unsafe preview cleanup target");
  }
  return candidate;
}

export function capturePreviewTempDirectoryOwnership(
  tempDirectory: string,
): PreviewTempDirectoryOwnership {
  const path = assertProtectedTemporaryDirectory(tempDirectory);
  const metadata = lstatSync(path);
  return {
    path,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function pathExistsSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

async function createQuarantine(
  ownership: PreviewTempDirectoryOwnership,
): Promise<QuarantineState> {
  for (;;) {
    const root = join(
      dirname(ownership.path),
      `${PREVIEW_TEMP_PREFIX}quarantine-${randomBytes(16).toString("hex")}`,
    );
    try {
      await mkdir(root, { mode: 0o700 });
      await chmod(root, 0o700);
      const metadata = await lstat(root);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (metadata.mode & 0o777) !== 0o700
      ) {
        throw new Error("Refusing unsafe preview quarantine root");
      }
      const state: QuarantineState = {
        root,
        entry: join(root, "owned"),
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        phase: "created",
      };
      quarantineStates.set(ownership, state);
      return state;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  }
}

function createQuarantineSync(
  ownership: PreviewTempDirectoryOwnership,
): QuarantineState {
  for (;;) {
    const root = join(
      dirname(ownership.path),
      `${PREVIEW_TEMP_PREFIX}quarantine-${randomBytes(16).toString("hex")}`,
    );
    try {
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);
      const metadata = lstatSync(root);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (metadata.mode & 0o777) !== 0o700
      ) {
        throw new Error("Refusing unsafe preview quarantine root");
      }
      const state: QuarantineState = {
        root,
        entry: join(root, "owned"),
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        phase: "created",
      };
      quarantineStates.set(ownership, state);
      return state;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  }
}

type AsyncFileHandle = Awaited<ReturnType<typeof open>>;

function isExpectedQuarantineRoot(
  state: QuarantineState,
  leaf: Stats,
  opened: Stats,
): boolean {
  return (
    !leaf.isSymbolicLink() &&
    leaf.isDirectory() &&
    opened.isDirectory() &&
    (leaf.mode & 0o777) === 0o700 &&
    leaf.dev === state.device &&
    leaf.ino === state.inode &&
    leaf.mode === state.mode &&
    opened.dev === state.device &&
    opened.ino === state.inode &&
    opened.mode === state.mode
  );
}

async function openVerifiedQuarantineRoot(
  state: QuarantineState,
): Promise<AsyncFileHandle> {
  let handle: AsyncFileHandle | undefined;
  try {
    const leaf = await lstat(state.root);
    handle = await open(
      state.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!isExpectedQuarantineRoot(state, leaf, opened)) throw new Error("changed identity");
    return handle;
  } catch {
    await handle?.close();
    throw new Error("Refusing changed preview quarantine root");
  }
}

async function assertOpenQuarantineRoot(
  state: QuarantineState,
  handle: AsyncFileHandle,
): Promise<void> {
  try {
    const leaf = await lstat(state.root);
    const opened = await handle.stat();
    if (!isExpectedQuarantineRoot(state, leaf, opened)) throw new Error("changed identity");
  } catch {
    throw new Error("Refusing changed preview quarantine root");
  }
}

function openVerifiedQuarantineRootSync(state: QuarantineState): number {
  let descriptor = -1;
  try {
    const leaf = lstatSync(state.root);
    descriptor = openSync(
      state.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (!isExpectedQuarantineRoot(state, leaf, opened)) throw new Error("changed identity");
    return descriptor;
  } catch {
    if (descriptor !== -1) closeSync(descriptor);
    throw new Error("Refusing changed preview quarantine root");
  }
}

function assertOpenQuarantineRootSync(
  state: QuarantineState,
  descriptor: number,
): void {
  try {
    const leaf = lstatSync(state.root);
    const opened = fstatSync(descriptor);
    if (!isExpectedQuarantineRoot(state, leaf, opened)) throw new Error("changed identity");
  } catch {
    throw new Error("Refusing changed preview quarantine root");
  }
}

async function assertQuarantinedIdentity(
  ownership: PreviewTempDirectoryOwnership,
  state: QuarantineState,
  rootHandle: AsyncFileHandle,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  await assertOpenQuarantineRoot(state, rootHandle);
  try {
    const leaf = await lstat(state.entry);
    handle = await open(
      state.entry,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat();
    if (
      leaf.isSymbolicLink() ||
      !leaf.isDirectory() ||
      !descriptor.isDirectory() ||
      leaf.dev !== ownership.device ||
      leaf.ino !== ownership.inode ||
      leaf.mode !== ownership.mode ||
      descriptor.dev !== leaf.dev ||
      descriptor.ino !== leaf.ino ||
      descriptor.mode !== leaf.mode
    ) {
      throw new Error("changed identity");
    }
  } catch {
    throw new Error("Refusing changed preview temporary directory");
  } finally {
    await handle?.close();
  }
  await assertOpenQuarantineRoot(state, rootHandle);
}

function assertQuarantinedIdentitySync(
  ownership: PreviewTempDirectoryOwnership,
  state: QuarantineState,
  rootDescriptor: number,
): void {
  let descriptor = -1;
  assertOpenQuarantineRootSync(state, rootDescriptor);
  try {
    const leaf = lstatSync(state.entry);
    descriptor = openSync(
      state.entry,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (
      leaf.isSymbolicLink() ||
      !leaf.isDirectory() ||
      !opened.isDirectory() ||
      leaf.dev !== ownership.device ||
      leaf.ino !== ownership.inode ||
      leaf.mode !== ownership.mode ||
      opened.dev !== leaf.dev ||
      opened.ino !== leaf.ino ||
      opened.mode !== leaf.mode
    ) {
      throw new Error("changed identity");
    }
  } catch {
    throw new Error("Refusing changed preview temporary directory");
  } finally {
    if (descriptor !== -1) closeSync(descriptor);
  }
  assertOpenQuarantineRootSync(state, rootDescriptor);
}

async function resolveQuarantineState(
  ownership: PreviewTempDirectoryOwnership,
): Promise<QuarantineState | undefined> {
  const source = assertOwnedPath(ownership);
  const state = quarantineStates.get(ownership);
  if (state !== undefined) return state;
  if (!await pathExists(source)) return undefined;
  return createQuarantine(ownership);
}

function resolveQuarantineStateSync(
  ownership: PreviewTempDirectoryOwnership,
): QuarantineState | undefined {
  const source = assertOwnedPath(ownership);
  const state = quarantineStates.get(ownership);
  if (state !== undefined) return state;
  if (!pathExistsSync(source)) return undefined;
  return createQuarantineSync(ownership);
}

export async function removePreviewTempDirectory(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewCleanupOptions = {},
): Promise<void> {
  const source = assertOwnedPath(ownership);
  const state = await resolveQuarantineState(ownership);
  if (state === undefined) return;
  const rootHandle = await openVerifiedQuarantineRoot(state);
  try {
    if (state.phase === "created") {
      await options.beforeQuarantineRename?.(source, state.entry);
      await assertOpenQuarantineRoot(state, rootHandle);
      await rename(source, state.entry);
      state.phase = "quarantined";
      await options.afterQuarantineRename?.(source, state.entry);
    }
    if (state.phase === "quarantined") {
      await assertQuarantinedIdentity(ownership, state, rootHandle);
      // Node has no recursive unlinkat API. Keeping the authenticated root descriptor
      // open and revalidating around this owned path is the strongest available
      // defense, but a hostile same-UID process can still race pathname resolution.
      await rm(state.entry, { force: false, recursive: true });
      state.phase = "entry-removed";
    }
    await assertOpenQuarantineRoot(state, rootHandle);
    await rmdir(state.root);
    quarantineStates.delete(ownership);
  } finally {
    await rootHandle.close();
  }
}

export function removePreviewTempDirectorySync(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewSyncCleanupOptions = {},
): void {
  const source = assertOwnedPath(ownership);
  const state = resolveQuarantineStateSync(ownership);
  if (state === undefined) return;
  const rootDescriptor = openVerifiedQuarantineRootSync(state);
  try {
    if (state.phase === "created") {
      options.beforeQuarantineRename?.(source, state.entry);
      assertOpenQuarantineRootSync(state, rootDescriptor);
      renameSync(source, state.entry);
      state.phase = "quarantined";
    }
    if (state.phase === "quarantined") {
      assertQuarantinedIdentitySync(ownership, state, rootDescriptor);
      // See the async path's unlinkat limitation. Never recursively remove root.
      rmSync(state.entry, { force: false, recursive: true });
      state.phase = "entry-removed";
    }
    assertOpenQuarantineRootSync(state, rootDescriptor);
    rmdirSync(state.root);
    quarantineStates.delete(ownership);
  } finally {
    closeSync(rootDescriptor);
  }
}

export function registerPreviewExitCleanup(
  ownership: PreviewTempDirectoryOwnership,
  processEvents: PreviewExitEventSource = process,
  options: PreviewSyncCleanupOptions = {},
): () => void {
  assertOwnedPath(ownership);
  let registered = true;
  const cleanup = () => {
    try {
      removePreviewTempDirectorySync(ownership, options);
    } catch {
      // Exit cleanup is fail-closed and never follows or deletes a changed identity.
    }
  };
  const unregister = () => {
    if (!registered) return;
    registered = false;
    processEvents.off("exit", cleanup);
  };
  processEvents.on("exit", cleanup);
  return unregister;
}
