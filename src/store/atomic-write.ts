import { link, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface AtomicWritePrecondition {
  expectedContent?: string | Uint8Array;
  targetMustNotExist?: boolean;
}

export interface AtomicWriteOperation {
  targetPath: string;
  tempPath: string;
  backupPath: string;
  content: string | Uint8Array;
  expectedContent?: string | Uint8Array;
  targetMustNotExist: boolean;
  existed: boolean;
}

export interface AtomicContentPreconditionOperation {
  targetPath: string;
  expectedContent: string | Uint8Array;
  verifyOnly: true;
}

export type AtomicOperation = AtomicWriteOperation | AtomicContentPreconditionOperation;

export function createAtomicWriteOperation(
  targetPath: string,
  content: string | Uint8Array,
  precondition: AtomicWritePrecondition = {},
): AtomicWriteOperation {
  if (precondition.expectedContent !== undefined && precondition.targetMustNotExist) {
    throw new Error("Atomic write cannot expect existing content and require an absent target.");
  }
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    targetPath,
    tempPath: `${targetPath}.tmp-${stamp}`,
    backupPath: `${targetPath}.bak-${stamp}`,
    content,
    ...(precondition.expectedContent === undefined ? {} : { expectedContent: precondition.expectedContent }),
    targetMustNotExist: precondition.targetMustNotExist ?? false,
    existed: false,
  };
}

export function createAtomicContentPreconditionOperation(
  targetPath: string,
  expectedContent: string | Uint8Array,
): AtomicContentPreconditionOperation {
  return { targetPath, expectedContent, verifyOnly: true };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

export async function commitAtomicWriteOperations(operations: AtomicOperation[]): Promise<void> {
  if (operations.length === 0) {
    return;
  }

  const locks = await acquireTransactionLocks(operations);
  try {
    await commitOwnedAtomicWriteOperations(operations);
  } finally {
    await releaseTransactionLocks(locks);
  }
}

async function commitOwnedAtomicWriteOperations(operations: AtomicOperation[]): Promise<void> {
  const writeOperations = operations.filter(isAtomicWriteOperation);
  const contentPreconditions = operations.filter(isAtomicContentPreconditionOperation);
  const prepared: AtomicWriteOperation[] = [];
  const movedToBackup: AtomicWriteOperation[] = [];
  const committed: AtomicWriteOperation[] = [];

  try {
    for (const operation of writeOperations) {
      await writeFile(operation.tempPath, operation.content);
      prepared.push(operation);
    }

    await verifyContentPreconditions(contentPreconditions);

    for (const operation of writeOperations) {
      operation.existed = operation.targetMustNotExist ? false : await pathExists(operation.targetPath);
      if (operation.existed) {
        await rename(operation.targetPath, operation.backupPath);
        movedToBackup.push(operation);
        if (operation.expectedContent !== undefined) {
          const currentContent = await readFile(operation.backupPath);
          if (!currentContent.equals(toBuffer(operation.expectedContent))) {
            throw new Error(`Atomic write precondition failed because "${operation.targetPath}" changed.`);
          }
        }
      } else if (operation.expectedContent !== undefined) {
        throw new Error(`Atomic write precondition failed because "${operation.targetPath}" is missing.`);
      }

      await link(operation.tempPath, operation.targetPath);
      committed.push(operation);
      await rm(operation.tempPath, { force: true });
    }

    await verifyContentPreconditions(contentPreconditions);
    await Promise.all(movedToBackup.map((operation) => rm(operation.backupPath, { force: true })));
    await Promise.all(prepared.map((operation) => rm(operation.tempPath, { force: true })));
  } catch (error) {
    for (const operation of committed.reverse()) {
      await rm(operation.targetPath, { force: true }).catch(() => undefined);
    }

    for (const operation of movedToBackup.reverse()) {
      await rename(operation.backupPath, operation.targetPath).catch(() => undefined);
    }

    await Promise.all(
      prepared.flatMap((operation) => [
        rm(operation.tempPath, { force: true }).catch(() => undefined),
        rm(operation.backupPath, { force: true }).catch(() => undefined),
      ]),
    );
    throw error;
  }
}

interface TransactionLock {
  lockPath: string;
  handle: FileHandle;
}

async function acquireTransactionLocks(operations: AtomicOperation[]): Promise<TransactionLock[]> {
  // Lock verification dependencies too: cooperating transactions must not change
  // them between the initial check and rollback/commit completion.
  const targets = [
    ...new Set(
      operations.map((operation) => {
        const resolved = path.resolve(operation.targetPath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      }),
    ),
  ].sort();
  const locks: TransactionLock[] = [];
  try {
    for (const target of targets) {
      const lockPath = target + ".atomic-lock";
      try {
        const handle = await open(lockPath, "wx");
        locks.push({ lockPath, handle });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error(
            'Atomic write ownership conflict for "' + target + '". Another transaction or a stale lock owns it.',
            { cause: error },
          );
        }
        throw error;
      }
    }
    return locks;
  } catch (error) {
    await releaseTransactionLocks(locks);
    throw error;
  }
}

async function releaseTransactionLocks(locks: TransactionLock[]): Promise<void> {
  for (const lock of locks.reverse()) {
    await lock.handle.close();
    await rm(lock.lockPath);
  }
}

async function verifyContentPreconditions(operations: AtomicContentPreconditionOperation[]): Promise<void> {
  for (const operation of operations) {
    try {
      const currentContent = await readFile(operation.targetPath);
      if (!currentContent.equals(toBuffer(operation.expectedContent))) {
        throw new Error(`Atomic write precondition failed because "${operation.targetPath}" changed.`);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`Atomic write precondition failed because "${operation.targetPath}" is missing.`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function isAtomicWriteOperation(operation: AtomicOperation): operation is AtomicWriteOperation {
  return !("verifyOnly" in operation);
}

function isAtomicContentPreconditionOperation(
  operation: AtomicOperation,
): operation is AtomicContentPreconditionOperation {
  return "verifyOnly" in operation;
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
