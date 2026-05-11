import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AcpRemoteHostRequestJournal,
  AcpRemoteHostRequestJournalEntry,
} from "./relay-connection.js";
import type { AnyMessage } from "@agentclientprotocol/sdk";

export type FileAcpRemoteHostRequestJournalOptions = {
  maxEntries?: number;
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
    writeChain = writeChain.then(async () => {
      const entries = await readEntries(options.path);
      await writeEntries(options.path, update(entries).slice(-maxEntries));
    });
    await writeChain;
  };

  return {
    async lookup(connectionId, id) {
      const entries = await readEntries(options.path);
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
): Promise<AcpRemoteHostRequestJournalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as JournalFile;
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
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
  await writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
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
