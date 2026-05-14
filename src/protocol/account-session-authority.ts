import type { AcpRemoteAccountSessionVerificationKey } from "./account-session.js";

export const ACP_REMOTE_BUILTIN_ACCOUNT_SESSION_VERIFICATION_KEYS = [
  {
    kid: "free-prod-2026-05-10",
    publicKey: "j_MbPwTNayLeKLl9e5EWHCfkQzW1kpNeEPFQPGBiAVw",
  },
  {
    kid: "free-default-2026-05-10",
    publicKey: "D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA",
  },
] as const satisfies readonly [
  AcpRemoteAccountSessionVerificationKey,
  ...AcpRemoteAccountSessionVerificationKey[],
];

export function readAcpRemoteAccountSessionVerificationKeys(
  configured?: string,
): readonly [
  AcpRemoteAccountSessionVerificationKey,
  ...AcpRemoteAccountSessionVerificationKey[],
] {
  if (!configured?.trim()) {
    return ACP_REMOTE_BUILTIN_ACCOUNT_SESSION_VERIFICATION_KEYS;
  }
  const parsed = JSON.parse(configured) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AccountSession public keys must be a non-empty JSON array.");
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { kid?: unknown }).kid !== "string" ||
      typeof (entry as { publicKey?: unknown }).publicKey !== "string"
    ) {
      throw new Error("AccountSession public key entries must include kid and publicKey strings.");
    }
    const { kid, publicKey } = entry as { kid: string; publicKey: string };
    return { kid, publicKey };
  }) as [
    AcpRemoteAccountSessionVerificationKey,
    ...AcpRemoteAccountSessionVerificationKey[],
  ];
}
