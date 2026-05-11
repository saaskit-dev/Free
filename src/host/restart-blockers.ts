import {
  countAcpRemoteHostInFlightRuntimeRequests,
  type AcpRemoteHostConnectionState,
} from "./relay-connection.js";

export type AcpRemoteHostRestartBlockers = {
  activeConnections: number;
  inFlightRuntimeRequests: number;
};

export function readHostRestartBlockers(
  state: AcpRemoteHostConnectionState,
): AcpRemoteHostRestartBlockers {
  return {
    activeConnections: state.active.size,
    inFlightRuntimeRequests:
      countAcpRemoteHostInFlightRuntimeRequests(state),
  };
}

export function hasHostRestartBlockers(
  blockers: AcpRemoteHostRestartBlockers,
): boolean {
  return blockers.inFlightRuntimeRequests > 0;
}
