import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
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
      const state = { root, entry: join(root, "owned") };
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
      const state = { root, entry: join(root, "owned") };
      quarantineStates.set(ownership, state);
      return state;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  }
}

async function assertQuarantinedIdentity(
  ownership: PreviewTempDirectoryOwnership,
  entry: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const leaf = await lstat(entry);
    handle = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW);
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
}

function assertQuarantinedIdentitySync(
  ownership: PreviewTempDirectoryOwnership,
  entry: string,
): void {
  let descriptor = -1;
  try {
    const leaf = lstatSync(entry);
    descriptor = openSync(entry, constants.O_RDONLY | constants.O_NOFOLLOW);
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
}

async function resolveQuarantinedEntry(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewCleanupOptions,
): Promise<QuarantineState | undefined> {
  const source = assertOwnedPath(ownership);
  let state = quarantineStates.get(ownership);
  if (state !== undefined && await pathExists(state.entry)) return state;
  if (!await pathExists(source)) {
    if (state !== undefined) {
      await rmdir(state.root).catch(() => undefined);
      quarantineStates.delete(ownership);
    }
    return undefined;
  }
  state ??= await createQuarantine(ownership);
  await options.beforeQuarantineRename?.(source, state.entry);
  try {
    await rename(source, state.entry);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") && await pathExists(state.entry)) return state;
    throw error;
  }
  await options.afterQuarantineRename?.(source, state.entry);
  return state;
}

function resolveQuarantinedEntrySync(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewSyncCleanupOptions,
): QuarantineState | undefined {
  const source = assertOwnedPath(ownership);
  let state = quarantineStates.get(ownership);
  if (state !== undefined && pathExistsSync(state.entry)) return state;
  if (!pathExistsSync(source)) {
    if (state !== undefined) {
      try { rmdirSync(state.root); } catch { /* A nonempty mismatch stays quarantined. */ }
      quarantineStates.delete(ownership);
    }
    return undefined;
  }
  state ??= createQuarantineSync(ownership);
  options.beforeQuarantineRename?.(source, state.entry);
  try {
    renameSync(source, state.entry);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") && pathExistsSync(state.entry)) return state;
    throw error;
  }
  return state;
}

export async function removePreviewTempDirectory(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewCleanupOptions = {},
): Promise<void> {
  const state = await resolveQuarantinedEntry(ownership, options);
  if (state === undefined) return;
  await assertQuarantinedIdentity(ownership, state.entry);
  await rm(state.root, { force: false, recursive: true });
  quarantineStates.delete(ownership);
}

export function removePreviewTempDirectorySync(
  ownership: PreviewTempDirectoryOwnership,
  options: PreviewSyncCleanupOptions = {},
): void {
  const state = resolveQuarantinedEntrySync(ownership, options);
  if (state === undefined) return;
  assertQuarantinedIdentitySync(ownership, state.entry);
  rmSync(state.root, { force: false, recursive: true });
  quarantineStates.delete(ownership);
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
