import { describe, expect, it } from "vitest";
import { hasHostRestartBlockers } from "./restart-blockers.js";

describe("host restart blockers", () => {
  it("does not block host restart for idle remote connections", () => {
    expect(
      hasHostRestartBlockers({
        activeConnections: 1,
        inFlightRuntimeRequests: 0,
      }),
    ).toBe(false);
  });

  it("blocks host restart while runtime requests are in flight", () => {
    expect(
      hasHostRestartBlockers({
        activeConnections: 0,
        inFlightRuntimeRequests: 1,
      }),
    ).toBe(true);
  });
});
