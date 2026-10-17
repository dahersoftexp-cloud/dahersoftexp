const assert = require("node:assert/strict");
const { test, before, beforeEach, afterEach, after } = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { io: clientSocket } = require("socket.io-client");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("./helpers/memory-database");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "isolated-auth-tests-only-do-not-deploy";
process.env.TENANTS_ROOT = "tenants";
process.env.DEFAULT_TENANT_ID = "default";
process.env.LEGACY_ROOT_TENANT_ID = "default";
process.env.TRIAL_MANAGER_USERNAME = "and";
delete process.env.ALLOW_LEGACY_PASSWORDS;

const owner = () => ({
  username: "owner",
  password: "old-password",
  role: "admin",
  permissions: [],
});
const initial = {
  users: {
    and: { username: "and", password: "root-password", role: "admin" },
    "root-only": {
      username: "root-only",
      password: "root-password",
      role: "user",
    },
  },
  tenants: {
    default: { sells: { rootInvoice: { id: "rootInvoice", customerId: "c" } } },
    "qa-a": {
      users: {
        owner: owner(),
        worker: {
          username: "worker",
          password: "worker-password",
          role: "user",
          permissions: ["products"],
        },
      },
      sells: { invoiceA: { id: "invoiceA", customerId: "c" } },
    },
    "qa-b": {
      users: { owner: { ...owner(), password: "other-password" } },
      sells: { invoiceB: { id: "invoiceB", customerId: "c" } },
    },
  },
};
const memory = createMemoryDatabase(initial);
const {
  app,
  generateToken,
  configureSocket,
  passwords,
  restoreDatabaseMock,
  getTenantDatabasePath,
} = loadWithMemoryDatabase(memory);
const server = http.createServer(app);
const sockets = configureSocket(server);
const peers = new Set();
let baseUrl;
let sharedHash;
const originalFetch = global.fetch;

before(async () => {
  sharedHash = await passwords.hashPassword("shared-password");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (url, options) => {
    assert.equal(new URL(url).origin, baseUrl);
    return originalFetch(url, options);
  };
});
beforeEach(() => memory.reset());
afterEach(() => {
  for (const peer of peers) peer.disconnect();
  peers.clear();
});
after(async () => {
  for (const peer of peers) peer.disconnect();
  global.fetch = originalFetch;
  await new Promise((resolve) => sockets.close(resolve));
  server.closeAllConnections();
  restoreDatabaseMock();
});

async function request(method, path, body, token, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": require("node:crypto").randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const login = (
  companyCode = "qa-a",
  username = "owner",
  password = "old-password",
) => request("POST", "/api/auth/login", { companyCode, username, password });
const write = (path, value) =>
  memory.sdk.set(memory.sdk.ref(null, path), value);
function connect(auth, query) {
  const peer = clientSocket(baseUrl, {
    auth,
    query,
    autoConnect: false,
    forceNew: true,
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
  peers.add(peer);
  return peer;
}
async function connected(peer) {
  const outcome = new Promise((resolve, reject) => {
    peer.once("connect", resolve);
    peer.once("connect_error", reject);
  });
  peer.connect();
  await outcome;
  return peer;
}
async function centralFixture() {
  await write("control/identities/person", {
    status: "active",
    passwordHash: sharedHash,
    sessionVersion: "v1",
  });
  for (const [tenantId, role] of [
    ["qa-a", "admin"],
    ["qa-b", "user"],
  ]) {
    await write(`tenants/${tenantId}/users/person`, {
      username: "person",
      identityId: "person",
    });
    await write(`control/memberships/${tenantId}/person`, {
      userId: "person",
      status: "active",
      role,
      permissions: ["home"],
    });
  }
}

test("HTTP refuses identity headers, invalid/expired tokens and unsigned roles before any data writes", async () => {
  const spoof = {
    "X-Inventory-Username": "and",
    "X-Inventory-User-Id": "and",
    "X-Inventory-Role": "admin",
    "X-Inventory-Tenant-Id": "qa-b",
  };
  for (const [method, url, body] of [
    ["GET", "/api/sells"],
    ["GET", "/api/users"],
    ["POST", "/api/trials", { tenantId: "qa-new" }],
    ["GET", "/api/ai/allData"],
    ["POST", "/api/transactions/sell", { newSell: {} }],
  ]) {
    assert.equal(
      (await request(method, url, body, undefined, spoof)).status,
      401,
    );
  }
  const expired = jwt.sign(
    { userId: "owner", tenantId: "qa-a" },
    process.env.JWT_SECRET,
    { expiresIn: -1 },
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, expired, spoof)).status,
    401,
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, "invalid", spoof)).status,
    401,
  );
  assert.equal(memory.writes.length, 0);
});

test("legacy root login remains read-only and its old tokens cannot select another company", async () => {
  const response = await request("POST", "/api/auth/login", {
    username: "and",
    password: "root-password",
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.user.tenantId, "default");
  assert.equal(memory.writes.length, 0);
  assert.equal(memory.dump().users.and.password, "root-password");
  const oldToken = generateToken({
    userId: "and",
    username: "and",
    role: "admin",
  });
  const listed = await request(
    "GET",
    "/api/sells?tenantId=qa-b",
    undefined,
    oldToken,
    { "X-Tenant-Id": "qa-b" },
  );
  assert.deepEqual(
    listed.data.map((row) => row.id),
    ["rootInvoice"],
  );
  assert.equal((await login("qa-b", "and", "root-password")).status, 401);
});

test("same username in two companies has separate identity and credential, with no discovery fallback", async () => {
  const a = await login();
  const b = await login("qa-b", "owner", "other-password");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.data.user.identityId, b.data.user.identityId);
  assert.equal((await login("qa-b")).status, 401);
  assert.equal((await login("unknown", "owner", "old-password")).status, 401);
  assert.equal((await login("qa-a/../qa-b")).status, 400);
  assert.equal((await login("qa-a", "../owner")).status, 400);
  const listed = await request(
    "GET",
    "/api/sells?companyCode=qa-b",
    undefined,
    a.data.token,
    { "X-Inventory-Tenant-Id": "qa-b" },
  );
  assert.deepEqual(
    listed.data.map((row) => row.id),
    ["invoiceA"],
  );
  assert.equal(
    (await request("GET", "/api/sells/invoiceB", undefined, a.data.token))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/sells/invoiceB",
        { data: { products: [] } },
        a.data.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await request("DELETE", "/api/sells/invoiceB", undefined, a.data.token))
      .status,
    404,
  );
  const exported = await request(
    "GET",
    "/api/ai/allData",
    undefined,
    a.data.token,
  );
  assert.equal(exported.status, 410);
  assert.doesNotMatch(
    JSON.stringify(exported.data),
    /invoiceB|rootInvoice|password|control/,
  );
  const tokenParts = a.data.token.split(".");
  const payload = JSON.parse(Buffer.from(tokenParts[1], "base64url"));
  payload.tenantId = "qa-b";
  tokenParts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(
    (await request("GET", "/api/sells", undefined, tokenParts.join(".")))
      .status,
    401,
  );
  assert.equal(memory.writes.length, 0);
});

test("draft sockets enforce action permissions at connection and after permission revocation", async () => {
  const worker = await login("qa-a", "worker", "worker-password");
  const refused = connect({ token: worker.data.token });
  await assert.rejects(connected(refused), /INVALID_SESSION/);
  const owner = await login();
  const peer = await connected(connect({ token: owner.data.token }));
  await write("tenants/qa-a/users/owner/role", "user");
  const writes = memory.writes.length;
  const disconnected = once(peer, "disconnect");
  peer.emit("invoice-draft:update", { draft: { note: "forbidden" } });
  await disconnected;
  assert.equal(memory.writes.length, writes);
  assert.equal(memory.dump().tenants["qa-a"].invoiceDrafts, undefined);
});

test("roles are refreshed from the database, not from signed claims or spoofed headers", async () => {
  const token = generateToken({
    userId: "worker",
    username: "worker",
    tenantId: "qa-a",
    role: "admin",
    permissions: ["users"],
  });
  assert.equal(
    (
      await request("GET", "/api/users", undefined, token, {
        "X-Inventory-Role": "admin",
      })
    ).status,
    403,
  );
  const a = await login();
  await write("tenants/qa-a/users/owner/role", "user");
  assert.equal(
    (await request("GET", "/api/users", undefined, a.data.token)).status,
    403,
  );
});

test("deleted users, cancelled membership and expired company deny already-open sessions", async () => {
  const a = await login();
  await write("tenants/qa-a/users/owner", null);
  assert.equal(
    (await request("GET", "/api/sells", undefined, a.data.token)).status,
    401,
  );
  memory.reset();
  await centralFixture();
  const shared = await login("qa-a", "person", "shared-password");
  assert.equal(shared.status, 200);
  await write("control/memberships/qa-a/person/status", "revoked");
  assert.equal(
    (await request("GET", "/api/sells", undefined, shared.data.token)).status,
    403,
  );
  memory.reset();
  const active = await login();
  await write("trialTenants/qa-a", {
    status: "active",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(
    (await request("GET", "/api/sells", undefined, active.data.token)).status,
    403,
  );
  assert.equal((await login()).status, 403);
});

test("a global identity can hold different roles in two companies without joining their data", async () => {
  await centralFixture();
  const a = await login("qa-a", "person", "shared-password");
  const b = await login("qa-b", "person", "shared-password");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.user.identityId, b.data.user.identityId);
  assert.equal(a.data.user.role, "admin");
  assert.equal(b.data.user.role, "user");
  assert.equal(
    (await request("GET", "/api/users", undefined, b.data.token)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/users/person",
        { password: "hijack-other-company" },
        a.data.token,
      )
    ).status,
    403,
  );
  await write("control/identities/person/managedByTenantId", "qa-a");
  assert.equal(
    (
      await request(
        "PUT",
        "/api/users/person",
        { password: "still-shared-identity" },
        a.data.token,
      )
    ).status,
    403,
  );
  await write("control/memberships/qa-a/person", null);
  assert.equal(
    (await request("GET", "/api/sells", undefined, a.data.token)).status,
    403,
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, b.data.token)).status,
    200,
  );
});

test("user creation, password reset and deletion stay within the company and never expose hashes", async () => {
  const a = await login();
  const other = memory.dump().tenants["qa-b"];
  const listed = await request("GET", "/api/users", undefined, a.data.token);
  assert.equal(listed.status, 200);
  assert.doesNotMatch(
    JSON.stringify(listed.data),
    /root-only|password|identityId/,
  );
  const created = await request(
    "POST",
    "/api/users",
    { username: "new-user", password: "first-password", role: "user" },
    a.data.token,
  );
  assert.equal(created.status, 200);
  const profile = memory.dump().tenants["qa-a"].users["new-user"];
  assert.equal(profile.password, undefined);
  const identity = memory.dump().control.identities[profile.identityId];
  assert.match(identity.passwordHash, /^scrypt-v1\$/);
  assert.equal(identity.password, undefined);
  const logged = await login("qa-a", "new-user", "first-password");
  assert.equal(logged.status, 200);
  assert.doesNotMatch(
    JSON.stringify(logged.data),
    /passwordHash|scrypt|sessionVersion|first-password/,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/users/new-user",
        { password: "second-password" },
        a.data.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, logged.data.token)).status,
    401,
  );
  assert.equal((await login("qa-a", "new-user", "first-password")).status, 401);
  const next = await login("qa-a", "new-user", "second-password");
  assert.equal(next.status, 200);
  assert.equal(
    (await request("DELETE", "/api/users/new-user", undefined, a.data.token))
      .status,
    200,
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, next.data.token)).status,
    401,
  );
  assert.deepEqual(memory.dump().tenants["qa-b"], other);
  assert.deepEqual(memory.dump().users, initial.users);
});

test("trials require platform manager; new company admin password is hashed and login works", async () => {
  const a = await login();
  assert.equal(
    (await request("POST", "/api/trials", { tenantId: "qa-new" }, a.data.token))
      .status,
    403,
  );
  const root = await request("POST", "/api/auth/login", {
    username: "and",
    password: "root-password",
  });
  const created = await request(
    "POST",
    "/api/trials",
    { tenantId: "qa-new", username: "owner", password: "new-company-password" },
    root.data.token,
  );
  assert.equal(created.status, 201);
  assert.equal(memory.dump().tenants["qa-new"].users.owner.password, undefined);
  assert.equal(
    (await login("qa-new", "owner", "new-company-password")).status,
    200,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/api/trials",
        { tenantId: "qa-new" },
        root.data.token,
      )
    ).status,
    409,
  );
});

test("tenant-owned references fail without context rather than accessing the default company", () => {
  assert.throws(
    () => getTenantDatabasePath("sells"),
    /TENANT_CONTEXT_REQUIRED/,
  );
  assert.throws(
    () => getTenantDatabasePath("tenants/qa-b/sells", "qa-a"),
    /CROSS_TENANT_PATH/,
  );
});

test("membership revocation through user management invalidates an existing session", async () => {
  const admin = await login();
  const worker = await login("qa-a", "worker", "worker-password");
  const revoked = await request(
    "PUT",
    "/api/users/worker",
    { status: "revoked" },
    admin.data.token,
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    (await request("GET", "/api/sells", undefined, worker.data.token)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/users/owner",
        { status: "revoked" },
        admin.data.token,
      )
    ).status,
    400,
  );
});

test("a default-company admin cannot reset the legacy platform manager's credential", async () => {
  await write("users/other-admin", {
    username: "other-admin",
    password: "other-root-password",
    role: "admin",
  });
  const admin = await request("POST", "/api/auth/login", {
    username: "other-admin",
    password: "other-root-password",
  });
  assert.equal(admin.status, 200);
  assert.equal(
    (
      await request(
        "PUT",
        "/api/users/and",
        { password: "hijack-platform" },
        admin.data.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("DELETE", "/api/users/and", undefined, admin.data.token))
      .status,
    403,
  );
  assert.equal(memory.dump().users.and.password, "root-password");
});

test("password hashes are salted, bounded and do not silently fall back to a legacy plaintext value", async () => {
  const first = await passwords.hashPassword(" spaced-password ");
  const second = await passwords.hashPassword(" spaced-password ");
  assert.notEqual(first, second);
  assert.equal(
    await passwords.verifyPassword(" spaced-password ", {
      passwordHash: first,
    }),
    true,
  );
  assert.equal(
    await passwords.verifyPassword("spaced-password", { passwordHash: first }),
    false,
  );
  assert.equal(
    await passwords.verifyPassword("plaintext", {
      passwordHash: "invalid",
      password: "plaintext",
    }),
    false,
  );
  await assert.rejects(
    passwords.hashPassword("x".repeat(1025)),
    /INVALID_PASSWORD/,
  );
});

test("database failures deny access without exposing internal credentials or switching tenants", async () => {
  const token = generateToken({ userId: "owner", tenantId: "qa-a" });
  const originalGet = memory.serverRead;
  memory.serverRead = async () => {
    throw new Error("PRIVATE-CREDENTIAL-FIXTURE");
  };
  try {
    const denied = await request("GET", "/api/sells", undefined, token);
    assert.equal(denied.status, 503);
    assert.deepEqual(denied.data, { error: "AUTH_UNAVAILABLE" });
  } finally {
    memory.serverRead = originalGet;
  }
});

test("legacy plaintext compatibility can be disabled without modifying the stored accounts", async () => {
  process.env.ALLOW_LEGACY_PASSWORDS = "false";
  try {
    assert.equal((await login()).status, 401);
    assert.equal(memory.writes.length, 0);
  } finally {
    delete process.env.ALLOW_LEGACY_PASSWORDS;
  }
});

test("malformed company metadata fails closed rather than treating the company as unrestricted", async () => {
  const a = await login();
  await write("control/companies/qa-a", "invalid-metadata");
  assert.equal(
    (await request("GET", "/api/sells", undefined, a.data.token)).status,
    503,
  );
});

test("login throttles repeated failures on the same normalized company and account", async () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal(
      (await login(attempt % 2 ? " QA-A " : "qa-a", "rate-test-user", "wrong"))
        .status,
      401,
    );
  }
  assert.equal((await login("qa-a", "rate-test-user", "wrong")).status, 429);
});

test(
  "Socket rejects header/query impersonation and disconnects revoked users",
  { timeout: 8000 },
  async () => {
    const forged = connect(
      { username: "owner", userId: "owner", tenantId: "qa-a" },
      { token: "invalid" },
    );
    const failure = new Promise((resolve) =>
      forged.once("connect_error", resolve),
    );
    forged.connect();
    assert.match((await failure).message, /INVALID_SESSION/);
    forged.disconnect();
    const logged = await login();
    const writer = await connected(
      connect({ token: logged.data.token, tenantId: "qa-b", userId: "owner" }),
    );
    const receiver = await connected(connect({ token: logged.data.token }));
    const changed = new Promise((resolve) =>
      receiver.once("invoice-draft:changed", resolve),
    );
    writer.emit("invoice-draft:update", {
      draft: { note: "synthetic", customerId: "c" },
      tenantId: "qa-b",
    });
    await changed;
    assert.ok(memory.dump().tenants["qa-a"].invoiceDrafts.owner);
    assert.equal(memory.dump().tenants["qa-b"].invoiceDrafts, undefined);
    await write("tenants/qa-a/users/owner/status", "revoked");
    const disconnected = new Promise((resolve) =>
      writer.once("disconnect", resolve),
    );
    writer.emit("invoice-draft:update", { draft: { note: "forbidden" } });
    await disconnected;
    receiver.disconnect();
    writer.disconnect();
  },
);

test(
  "a socket whose credential changed cannot receive broadcasts from a newer valid session",
  { timeout: 8000 },
  async () => {
    const oldLogin = await login();
    const stale = await connected(connect({ token: oldLogin.data.token }));
    let leaked = false;
    stale.on("invoice-draft:changed", () => {
      leaked = true;
    });
    await write(
      "tenants/qa-a/users/owner/sessionVersion",
      "new-session-version",
    );
    const freshLogin = await login();
    const writer = await connected(connect({ token: freshLogin.data.token }));
    const disconnected = new Promise((resolve) =>
      stale.once("disconnect", resolve),
    );
    writer.emit("invoice-draft:update", {
      draft: { note: "only-for-current-session" },
    });
    await disconnected;
    assert.equal(leaked, false);
  },
);
