import type { AcpRemoteFrame } from "./types.js";
import { assertAcpRemoteFrame } from "./validation.js";

export function parseAcpRemoteFrameText(text: string): AcpRemoteFrame | undefined {
  try {
    return assertAcpRemoteFrame(JSON.parse(text));
  } catch {
    return undefined;
  }
}
