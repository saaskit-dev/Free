import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createFileAcpRemoteHostRequestJournal } from "./request-journal.js";

describe("createFileAcpRemoteHostRequestJournal", () => {
  it("returns completed duplicate responses from the file journal", async () => {
    const path = await createJournalPath();
    const journal = createFileAcpRemoteHostRequestJournal({ path });

    await journal.markReceived({
      connectionId: "conn-1",
      id: "req-1",
      method: "session/prompt",
      status: "received",
    });
    await journal.markCompleted({
      connectionId: "conn-1",
      id: "req-1",
      method: "session/prompt",
      payload: {
        id: "req-1",
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      },
      status: "completed",
    });

    await expect(journal.lookup("conn-1", "req-1")).resolves.toMatchObject({
      payload: {
        id: "req-1",
        result: { stopReason: "end_turn" },
      },
      status: "completed",
    });
  });

  it("does not crash the host when the persisted journal is corrupt", async () => {
    const path = await createJournalPath();
    await writeFile(path, '{"entries":[', "utf-8");
    const journal = createFileAcpRemoteHostRequestJournal({ path });

    await expect(journal.lookup("conn-1", "req-1")).resolves.toBeUndefined();
    await journal.markReceived({
      connectionId: "conn-1",
      id: "req-1",
      method: "session/prompt",
      status: "received",
    });

    const next = JSON.parse(await readFile(path, "utf-8")) as {
      entries: unknown[];
    };
    expect(next.entries).toHaveLength(1);
  });
});

async function createJournalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "free-request-journal-"));
  return join(directory, "host-request-journal.json");
}
