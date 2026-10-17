function getSmokeTarget(environment = process.env) {
  if (environment.SMOKE_ALLOW_WRITES !== "isolated-test-database") {
    throw new Error("Smoke writes require SMOKE_ALLOW_WRITES=isolated-test-database and a disposable local database.");
  }
  if (!environment.API_BASE_URL) {
    throw new Error("API_BASE_URL must explicitly point to a loopback test server. There is no production default.");
  }
  const url = new URL(environment.API_BASE_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error("Smoke tests accept only a plain loopback server URL without credentials, query, or path.");
  }
  const runId = environment.SMOKE_RUN_ID || Date.now().toString(36);
  const tenantId = environment.SMOKE_TENANT_ID || `qa-smoke-${runId}`;
  if (!/^qa-smoke-[a-z0-9_-]+$/.test(tenantId)) {
    throw new Error("SMOKE_TENANT_ID must use the disposable qa-smoke- prefix.");
  }
  return { baseUrl: url.origin, runId, tenantId };
}

function assertIsolatedLogin(response, tenantId) {
  if (!response?.ok || response.data?.user?.tenantId !== tenantId) {
    throw new Error("Smoke stopped: login did not resolve to the disposable tenant.");
  }
  const token = response.data?.token;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Smoke stopped: login returned no usable token.");
  }
  // This is a routing precondition, not a substitute for server JWT verification.
  if (payload.tenantId !== tenantId) {
    throw new Error("Smoke stopped: token does not identify the disposable tenant.");
  }
}

module.exports = { getSmokeTarget, assertIsolatedLogin };
