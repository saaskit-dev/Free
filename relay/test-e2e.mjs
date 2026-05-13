// Quick E2E test: Workbench login API → account session → host list → authorize page
// Usage: ACP_RELAY_GITHUB_CLIENT_ID=... ACP_RELAY_GITHUB_CLIENT_SECRET=... node test-e2e.mjs

import {
  createAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
} from "../dist/protocol/index.js";

const RELAY = process.env.RELAY_URL || "http://localhost:8791";
const HAS_GITHUB_OAUTH =
  Boolean(process.env.ACP_RELAY_GITHUB_CLIENT_ID) &&
  Boolean(process.env.ACP_RELAY_GITHUB_CLIENT_SECRET);
const LOCAL_ACCOUNT_SESSION_KEY = {
  kid: "free-default-2026-05-10",
  privateKey: "MC4CAQAwBQYDK2VwBCIEIE3QzRbUWyHMh9gdhq_2qUXX_NzCJpJFhxtndaTTRvb3",
  publicKey: "D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA",
};

async function main() {
  // 1. GET /api/login/start. Without local GitHub OAuth config the expected
  //    result is a clear 503; with OAuth config it returns a GitHub URL.
  console.log("1. Testing /api/login/start...");
  const loginRes = await fetch(`${RELAY}/api/login/start?returnTo=/authorize&redirectUri=http%3A%2F%2F127.0.0.1%3A8790%2Flogin%2Fcallback`, {
    headers: { Origin: "http://127.0.0.1:8790" },
  });
  console.log(`   Status: ${loginRes.status}`);
  if (HAS_GITHUB_OAUTH) {
    assert(loginRes.status === 200, "Expected /api/login/start to return JSON with GitHub OAuth config");
    const loginBody = await loginRes.json();
    assert(loginBody.authorizationUrl.includes("github.com/login/oauth/authorize"), "Expected GitHub OAuth URL");
    console.log(`   ✓ Returns GitHub OAuth URL`);
  } else {
    assert(loginRes.status === 503, "Expected /api/login/start to report missing GitHub OAuth config");
    console.log(`   ✓ Reports missing GitHub OAuth config`);
  }

  // 2. Check /api/hosts requires auth
  console.log("\n2. Testing /api/hosts requires auth...");
  const apiRes = await fetch(`${RELAY}/api/hosts`);
  console.log(`   Status: ${apiRes.status}`);
  console.log(`   Body: ${await apiRes.text()}`);
  assert(apiRes.status === 401, "Expected /api/hosts without auth to return 401");
  console.log(`   ✓ Returns 401 without session`);

  // 3. Check /authorize requires connectionId
  console.log("\n3. Testing /authorize requires connectionId...");
  const authRes = await fetch(`${RELAY}/authorize`);
  console.log(`   Status: ${authRes.status}`);
  console.log(`   Body: ${await authRes.text()}`);
  assert(authRes.status === 401, "Expected /authorize without auth to return 401");
  console.log(`   ✓ Returns 401 without session`);

  // 4. Manually create an account session.
  console.log("\n4. Creating test account session...");
  const sessionId = crypto.randomUUID();
  const accountId = "test-account-" + sessionId.slice(0, 8);
  const accountSession = await createAcpRemoteAccountSession({
    accountId,
    principalId: "local-e2e-client",
    principalPublicKey: LOCAL_ACCOUNT_SESSION_KEY.publicKey,
    principalType: "client",
    sessionId,
    signingKey: LOCAL_ACCOUNT_SESSION_KEY,
  });
  const accountSessionValue = encodeAcpRemoteAccountSession(accountSession);
  console.log(`   AccountSession: ${accountSessionValue.slice(0, 20)}...`);
  console.log(`   AccountId: ${accountId}`);

  // 5. Use account session to access /api/hosts
  console.log("\n5. Testing /api/hosts with account session...");
  const apiAuthRes = await fetch(`${RELAY}/api/hosts`, {
    headers: { Authorization: `Bearer ${accountSessionValue}` },
  });
  console.log(`   Status: ${apiAuthRes.status}`);
  const apiAuthBody = await apiAuthRes.text();
  console.log(`   Body: ${apiAuthBody}`);
  assert(apiAuthRes.status === 200, "Expected /api/hosts with session to return 200");
  assert(Array.isArray(JSON.parse(apiAuthBody).hosts), "Expected host list response");
  console.log(`   ✓ Returns 200 with session`);

  // 6. Use account session to access /authorize for an unknown connection.
  console.log("\n6. Testing /authorize with account session and unknown connection...");
  const authAuthRes = await fetch(`${RELAY}/authorize?connectionId=test-conn-123`, {
    headers: { Authorization: `Bearer ${accountSessionValue}` },
  });
  console.log(`   Status: ${authAuthRes.status}`);
  const body = await authAuthRes.text();
  console.log(`   Body length: ${body.length}`);
  assert(authAuthRes.status === 410, "Expected unknown connection authorize page to return 410");
  assert(body.includes("connection"), "Expected connection error message");
  console.log(`   ✓ Returns connection error page`);

  // 7. Test POST /authorize
  console.log("\n7. Testing POST /authorize...");
  const postRes = await fetch(`${RELAY}/authorize?connectionId=test-conn-123`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accountSessionValue}`, "Content-Type": "application/json" },
    body: JSON.stringify({ hostId: "nonexistent-host" }),
  });
  console.log(`   Status: ${postRes.status}`);
  const postBody = await postRes.json();
  console.log(`   Body: ${JSON.stringify(postBody)}`);
  assert(postRes.status === 404, "Expected POST /authorize unknown connection to return 404");
  assert(postBody?.ok === false, "Expected POST /authorize failure body");
  console.log(`   ✓ Returns 404 for unknown connection`);

  console.log("\n✅ All checks passed!");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
