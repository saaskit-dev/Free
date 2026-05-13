import { useCallback, useEffect, useState } from "react";

import { loadHosts, loadSession } from "../api/relay";
import type { AccountSession, HostRecord, LoadState } from "../types";

type WorkbenchData = {
  hosts: LoadState<HostRecord[]>;
  refresh: () => Promise<void>;
  session: LoadState<AccountSession>;
};

export function useWorkbenchData(): WorkbenchData {
  const [hosts, setHosts] = useState<WorkbenchData["hosts"]>({ status: "loading" });
  const [session, setSession] = useState<WorkbenchData["session"]>({ status: "loading" });

  const refresh = useCallback(async () => {
    setHosts({ status: "loading" });
    setSession({ status: "loading" });

    const sessionResult = await loadSession();
    if (!sessionResult.ok) {
      const state =
        sessionResult.status === 401
          ? { status: "unauthorized" as const, message: sessionResult.message }
          : { status: "error" as const, message: sessionResult.message };
      setSession(state);
      setHosts(state);
      return;
    }
    setSession({ status: "ready", data: sessionResult.value });

    const hostsResult = await loadHosts();
    if (!hostsResult.ok) {
      setHosts({
        status: hostsResult.status === 401 ? "unauthorized" : "error",
        message: hostsResult.message,
      });
      return;
    }
    setHosts({ status: "ready", data: hostsResult.value.hosts });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { hosts, refresh, session };
}
