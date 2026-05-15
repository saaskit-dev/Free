import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AcpRemoteHostRequestJournal,
  AcpRemoteHostRequestJournalEntry,
} from "./relay-connection.js";
import type { AnyMessage } from "@agentclientprotocol/sdk";

export type FileAcpRemoteHostRequestJournalOptions = {
  maxEntries?: number;
  onCorruptJournal?: (input: {
    corruptPath?: string;
    error: SyntaxError;
    path: string;
  }) => void;
  path: string;
};

const DEFAULT_MAX_ENTRIES = 512;

type JournalFile = {
  entries?: AcpRemoteHostRequestJournalEntry[];
};

export function createFileAcpRemoteHostRequestJournal(
  options: FileAcpRemoteHostRequestJournalOptions,
): AcpRemoteHostRequestJournal {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let writeChain = Promise.resolve();

  const mutate = async (
    update: (
      entries: AcpRemoteHostRequestJournalEntry[],
    ) => AcpRemoteHostRequestJournalEntry[],
  ) => {
    const operation = writeChain.catch(() => undefined).then(async () => {
      const entries = await readEntries(options.path, options.onCorruptJournal);
      await writeEntries(options.path, update(entries).slice(-maxEntries));
    });
    writeChain = operation.catch(() => undefined);
    await operation;
  };

  return {
    async lookup(connectionId, id) {
      await writeChain.catch(() => undefined);
      const entries = await readEntries(options.path, options.onCorruptJournal);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.connectionId === connectionId && entry.id === id) {
          return entry;
        }
      }
      return undefined;
    },
    async markCompleted(entry) {
      await mutate((entries) =>
        upsertEntry(entries, {
          connectionId: entry.connectionId,
          id: entry.id,
          method: entry.method,
          payload: entry.payload,
          status: "completed",
        }),
      );
    },
    async markReceived(entry) {
      await mutate((entries) =>
        upsertEntry(entries, {
          connectionId: entry.connectionId,
          id: entry.id,
          method: entry.method,
          status: "received",
        }),
      );
    },
  };
}

async function readEntries(
  path: string,
  onCorruptJournal?: FileAcpRemoteHostRequestJournalOptions["onCorruptJournal"],
): Promise<AcpRemoteHostRequestJournalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as JournalFile;
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    if (error instanceof SyntaxError) {
      const corruptPath = await quarantineCorruptJournal(path);
      onCorruptJournal?.({ corruptPath, error, path });
      return [];
    }
    throw error;
  }
}

async function writeEntries(
  path: string,
  entries: readonly AcpRemoteHostRequestJournalEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ entries }, null, 2)}\n`,
    "utf-8",
  );
  await rename(temporaryPath, path);
}

async function quarantineCorruptJournal(path: string): Promise<string | undefined> {
  const corruptPath = `${path}.corrupt-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  try {
    await rename(path, corruptPath);
    return corruptPath;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function upsertEntry(
  entries: readonly AcpRemoteHostRequestJournalEntry[],
  entry: AcpRemoteHostRequestJournalEntry,
): AcpRemoteHostRequestJournalEntry[] {
  return [...entries.filter((item) => !sameRequest(item, entry)), entry];
}

function sameRequest(
  left: AcpRemoteHostRequestJournalEntry,
  right: AcpRemoteHostRequestJournalEntry,
): boolean {
  return left.connectionId === right.connectionId && left.id === right.id;
}

function isEntry(value: unknown): value is AcpRemoteHostRequestJournalEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as {
    connectionId?: unknown;
    id?: unknown;
    payload?: unknown;
    status?: unknown;
  };
  return (
    typeof entry.connectionId === "string" &&
    (typeof entry.id === "string" || typeof entry.id === "number") &&
    (entry.status === "received" ||
      (entry.status === "completed" && isMessage(entry.payload)))
  );
}

function isMessage(value: unknown): value is AnyMessage {
  return typeof value === "object" && value !== null;
}
