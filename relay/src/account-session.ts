import {
  decodeAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
  verifyAcpRemoteAccountSession,
  type AcpRemoteAccountSession,
  type AcpRemoteAccountSessionVerificationKey,
} from "../../src/protocol/index.js";

export type AcpRelayAccountSession = AcpRemoteAccountSession;

export type AcpRelayAccountSessionVerificationResult =
  | {
      ok: true;
      session: AcpRelayAccountSession;
    }
  | {
      ok: false;
      reason: string;
    };

export function encodeAcpRelayAccountSession(
  session: AcpRelayAccountSession,
): string {
  return encodeAcpRemoteAccountSession(session);
}

export async function verifyAcpRelayAccountSessionValue(input: {
  now?: Date;
  value: string;
  verificationKeys:
    | AcpRemoteAccountSessionVerificationKey
    | readonly AcpRemoteAccountSessionVerificationKey[];
}): Promise<AcpRelayAccountSessionVerificationResult> {
  let session: AcpRelayAccountSession;
  try {
    session = decodeAcpRemoteAccountSession(input.value);
  } catch {
    return { ok: false, reason: "Invalid ACP account session." };
  }

  const verification = await verifyAcpRemoteAccountSession(
    session,
    input.verificationKeys,
    { now: input.now },
  );
  return verification.ok ? { ok: true, session } : verification;
}
