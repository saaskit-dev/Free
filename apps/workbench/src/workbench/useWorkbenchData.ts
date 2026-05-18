import { useCallback, useEffect, useState } from "react";

import { loadHosts, loadSession, loadSessions } from "../api/relay";
import type { AccountSession, HostRecord, LoadState, SessionRecord } from "../types";

type WorkbenchData = {
  hosts: LoadState<HostRecord[]>;
  markSessionClosed: (sessionId: string) => void;
  refresh: () => Promise<void>;
  refreshSessions: (options?: { loading?: boolean }) => Promise<void>;
  session: LoadState<AccountSession>;
  sessions: LoadState<SessionRecord[]>;
};

export function useWorkbenchData(): WorkbenchData {
  const [hosts, setHosts] = useState<WorkbenchData["hosts"]>({ status: "loading" });
  const [session, setSession] = useState<WorkbenchData["session"]>({ status: "loading" });
  const [sessions, setSessions] = useState<WorkbenchData["sessions"]>({ status: "loading" });

  const refreshHosts = useCallback(async (options: { loading?: boolean } = {}) => {
    if (options.loading) {
      setHosts({ status: "loading" });
    }
    const hostsResult = await safeLoad(loadHosts);
    if (!hostsResult.ok) {
      setHosts({
        status: hostsResult.status === 401 ? "unauthorized" : "error",
        message: hostsResult.message,
      });
      return;
    }
    setHosts({ status: "ready", data: hostsResult.value.hosts });
  }, []);

  const refreshSessions = useCallback(async (options: { loading?: boolean } = {}) => {
    if (options.loading) {
      setSessions({ status: "loading" });
    }
    const sessionsResult = await safeLoad(loadSessions);
    if (!sessionsResult.ok) {
      setSessions({
        status: sessionsResult.status === 401 ? "unauthorized" : "error",
        message: sessionsResult.message,
      });
      return;
    }
    setSessions({ status: "ready", data: sessionsResult.value.sessions });
  }, []);

  const markSessionClosed = useCallback((sessionId: string) => {
    const closedAt = new Date().toISOString();
    setSessions((current) => {
      if (current.status !== "ready") return current;
      return {
        status: "ready",
        data: current.data.map((sessionRecord) =>
          sessionRecord.sessionId === sessionId
            ? {
                ...sessionRecord,
                bridgeConnected: false,
                closedAt,
                connectionId: undefined,
                hasActiveEvent: false,
                latestEvent: "ACP session was closed.",
                lifecycle: "offline",
                status: "offline",
                updatedAt: closedAt,
              }
            : sessionRecord
        ),
      };
    });
  }, []);

  const refresh = useCallback(async () => {
    setHosts({ status: "loading" });
    setSession({ status: "loading" });
    setSessions({ status: "loading" });

    const sessionResult = await safeLoad(loadSession);
    if (!sessionResult.ok) {
      const state =
        sessionResult.status === 401
          ? { status: "unauthorized" as const, message: sessionResult.message }
          : { status: "error" as const, message: sessionResult.message };
      setSession(state);
      setHosts(state);
      setSessions(state);
      return;
    }
    setSession({ status: "ready", data: sessionResult.value });
    await Promise.all([refreshHosts(), refreshSessions()]);
  }, [refreshHosts, refreshSessions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (session.status !== "ready") return;
    const refreshOnlineHosts = () => {
      void refreshHosts();
      void refreshSessions();
    };
    const interval = setInterval(refreshOnlineHosts, 3000);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refreshOnlineHosts);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshOnlineHosts);
    }
    return () => {
      clearInterval(interval);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refreshOnlineHosts);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", refreshOnlineHosts);
      }
    };
  }, [refreshHosts, refreshSessions, session.status]);

  return { hosts, markSessionClosed, refresh, refreshSessions, session, sessions };
}

async function safeLoad<T>(
  loader: () => Promise<
    | { ok: true; value: T }
    | { ok: false; status: number; message: string }
  >,
): Promise<
  | { ok: true; value: T }
  | { ok: false; status: number; message: string }
> {
  try {
    return await loader();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
