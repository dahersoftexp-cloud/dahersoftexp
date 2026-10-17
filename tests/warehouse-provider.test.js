const assert = require("node:assert/strict");
const { test, before, beforeEach, afterEach, after } = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const { io: clientSocket } = require("socket.io-client");
const {
  createServerDatabaseClient,
} = require("../dist/infrastructure/serverDatabase");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("./helpers/memory-database");
const { createRestDatabaseServer } = require("./helpers/rest-database-server");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "isolated-provider-tests-do-not-deploy";
process.env.TENANTS_ROOT = "tenant-fixtures";
process.env.DEFAULT_TENANT_ID = "default";
process.env.LEGACY_ROOT_TENANT_ID = "default";
const owner = {
  username: "owner",
  password: "local-only",
  role: "admin",
  permissions: [],
};
const first = {
  id: "original-a",
  name: "المستودع الرئيسي",
  isActive: true,
  createdDate: "historical",
  updatedDate: "historical",
  futureField: { preserve: true },
};
const inactive = {
  id: "original-inactive",
  name: "مستودع مغلق",
  isActive: false,
  type: "vehicle",
  driverId: "old-driver",
  openingField: 47,
};
const second = { id: "original-b", name: "Company B", isActive: true };
const memory = createMemoryDatabase({
  control: {
    companies: { "qa-a": { status: "active", entitlements: { ai: true } } },
  },
  "tenant-fixtures": {
    "qa-a": {
      users: { owner },
      warehouses: { "original-a": first, "original-inactive": inactive },
      ai: {
        lastResponse: {
          title: "QA report",
          rawText: "local report",
          createdAt: "2026-01-01",
        },
      },
    },
    "qa-b": { users: { owner }, warehouses: { "original-b": second } },
  },
});
let transport, dbUrl, apiUrl;
let failure;
let remotePaths = [];
const peers = new Set();
const originalFetch = global.fetch;
const databaseFixture = createRestDatabaseServer(memory, {
  failure: (target, method) => failure?.(target, method),
  onRequest: ({ path }) => remotePaths.push(path),
});
const databaseServer = databaseFixture.server;
const {
  app,
  generateToken,
  configureSocket,
  runWithTenant,
  restoreDatabaseMock,
} = loadWithMemoryDatabase(memory, {
  serverReader: (target) => transport.read(target),
  serverVersionedReader: (target) => transport.readVersioned(target),
  serverCompareAndSet: (target, revision, value) =>
    transport.compareAndSet(target, revision, value),
});
const { getTenantDatabase } = require("../dist/tenancy/tenantDatabaseProvider");
const { resolveActiveTenant } = require("../dist/tenancy/tenantResolver");
const {
  getWarehouseRepository,
} = require("../dist/repositories/warehouses.repository");
const {
  getAllWarehousesInternal,
  getWarehouseByIdInternal,
} = require("../dist/controllers/warehouses.controller");
const apiServer = http.createServer(app);
const sockets = configureSocket(apiServer);
before(async () => {
  databaseServer.listen(0, "127.0.0.1");
  await once(databaseServer, "listening");
  dbUrl = `http://127.0.0.1:${databaseServer.address().port}`;
  transport = createServerDatabaseClient({
    baseUrl: dbUrl,
    allowLoopback: true,
    fetch: originalFetch,
    timeoutMs: 1000,
  });
  apiServer.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
  global.fetch = (url, options) => {
    assert.ok(
      [apiUrl, dbUrl].includes(new URL(url).origin),
      "External requests are forbidden",
    );
    return originalFetch(url, options);
  };
});
beforeEach(() => {
  memory.reset();
  failure = undefined;
  remotePaths = [];
  databaseFixture.requests.length = 0;
  delete databaseFixture.hooks.beforeRead;
  delete databaseFixture.hooks.beforeWrite;
  delete databaseFixture.hooks.rejectWrites;
});

const warehousePath = "tenant-fixtures/qa-a/warehouses/original-a";
const synchronizeTwoReads = () => {
  let count = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  databaseFixture.hooks.beforeRead = async ({ path, headers }) => {
    if (
      path !== warehousePath ||
      headers["x-firebase-etag"] !== "true" ||
      count >= 2
    )
      return;
    count++;
    if (count === 2) release();
    await barrier;
  };
};

test("warehouse changes preserve old fields and reject a stale form revision", async () => {
  const changed = await request("PUT", "/api/warehouses/original-a", {
    location: "New location",
    expectedRevision: 0,
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.data.revision, 1);
  assert.deepEqual(changed.data.data.futureField, first.futureField);
  assert.equal(changed.data.data.id, first.id);
  assert.equal(changed.data.data.name, first.name);
  assert.equal(changed.data.data.createdDate, first.createdDate);
  const stale = await request("PUT", "/api/warehouses/original-a", {
    location: "Stale location",
    expectedRevision: 0,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, "WAREHOUSE_CONFLICT");
  assert.equal(
    memory.dump()["tenant-fixtures"]["qa-a"].warehouses["original-a"].location,
    "New location",
  );
  assert.equal(memory.writes.length, 1);
  assert.equal(
    (await request("PUT", "/api/warehouses/missing", { location: "x" })).status,
    404,
  );
});

test("immutable identity fields and malformed writes are rejected before a PUT", async () => {
  for (const body of [
    { name: "Renamed" },
    { id: "other" },
    { type: "vehicle" },
    { isActive: "false" },
    { location: 7 },
    { expectedRevision: -1 },
  ])
    assert.equal(
      (await request("PUT", "/api/warehouses/original-a", body)).status,
      400,
    );
  for (const name of ["", "bad/name", "bad.name", "bad\u0000name"])
    assert.equal(
      (await request("POST", "/api/warehouses", { name })).status,
      400,
    );
  assert.equal(memory.writes.length, 0);
  assert.equal(
    databaseFixture.requests.filter((entry) => entry.method === "PUT").length,
    0,
  );
});

test(
  "concurrent updates of different fields merge after an ETag conflict",
  { timeout: 5000 },
  async () => {
    synchronizeTwoReads();
    await runWithTenant("qa-a", async () => {
      await Promise.all([
        getWarehouseRepository().update("original-a", {
          location: "Concurrent location",
        }),
        getWarehouseRepository().update("original-a", { isActive: false }),
      ]);
    });
    const record =
      memory.dump()["tenant-fixtures"]["qa-a"].warehouses["original-a"];
    assert.equal(record.location, "Concurrent location");
    assert.equal(record.isActive, false);
    assert.equal(record.revision, 2);
    assert.deepEqual(record.futureField, first.futureField);
    assert.equal(memory.writes.length, 2);
    assert.equal(
      databaseFixture.requests.filter((entry) => entry.method === "PUT").length,
      3,
    );
  },
);

test(
  "overlapping concurrent changes fail with a conflict instead of silently overwriting",
  { timeout: 5000 },
  async () => {
    synchronizeTwoReads();
    const outcomes = await runWithTenant("qa-a", () =>
      Promise.allSettled([
        getWarehouseRepository().update("original-a", { location: "A" }),
        getWarehouseRepository().update("original-a", { location: "B" }),
      ]),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.find((outcome) => outcome.status === "rejected").reason.code,
      "WAREHOUSE_CONFLICT",
    );
    assert.equal(memory.writes.length, 1);
  },
);

test("repeated ETag conflicts are bounded and do not overwrite another writer's fields", async () => {
  let conflicts = 0;
  databaseFixture.hooks.beforeWrite = async ({ path }) => {
    if (path === warehousePath)
      await memory.sdk.update(memory.sdk.ref(null, path), {
        external: ++conflicts,
      });
  };
  const result = await request("PUT", "/api/warehouses/original-a", {
    location: "must not win",
  });
  assert.equal(result.status, 409);
  assert.equal(conflicts, 5);
  const stored =
    memory.dump()["tenant-fixtures"]["qa-a"].warehouses["original-a"];
  assert.equal(stored.location, undefined);
  assert.equal(stored.external, 5);
});

test(
  "two simultaneous creations of the same normalized name across warehouse and vehicle APIs create one record",
  { timeout: 5000 },
  async () => {
    const outcomes = await Promise.all([
      request("POST", "/api/warehouses", { name: " Shared new name " }),
      request("POST", "/api/vehicles", { name: "shared NEW name" }),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status).sort(),
      [200, 409],
    );
    const records = Object.values(
      memory.dump()["tenant-fixtures"]["qa-a"].warehouses,
    );
    assert.equal(records.length, 3);
    assert.equal(
      records.filter(
        (record) => record.name.toLowerCase() === "shared new name",
      ).length,
      1,
    );
    const legacy = await request("POST", "/api/warehouses", {
      name: ` ${first.name} `,
    });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.data.warehouseId, first.id);
  },
);

test("a lost write acknowledgement returns an unknown outcome and a repeat cannot create a second warehouse", async () => {
  failure = (_target, method) => (method === "PUT" ? "after" : false);
  const unknown = await request("POST", "/api/warehouses", {
    name: "Uncertain save",
  });
  assert.equal(unknown.status, 503);
  assert.equal(unknown.data.error, "WAREHOUSE_WRITE_OUTCOME_UNKNOWN");
  assert.ok(unknown.data.warehouseId);
  assert.equal(
    memory.dump()["tenant-fixtures"]["qa-a"].warehouses[
      unknown.data.warehouseId
    ].name,
    "Uncertain save",
  );
  assert.equal(
    databaseFixture.requests.filter((entry) => entry.method === "PUT").length,
    1,
  );
  failure = undefined;
  assert.equal(
    (await request("POST", "/api/warehouses", { name: "Uncertain save" }))
      .status,
    409,
  );
  assert.equal(
    Object.values(memory.dump()["tenant-fixtures"]["qa-a"].warehouses).filter(
      (record) => record.name === "Uncertain save",
    ).length,
    1,
  );
});

test("write rejection does not trigger retries or claim an unconfirmed success", async () => {
  databaseFixture.hooks.rejectWrites = 403;
  const rejected = await request("POST", "/api/warehouses", { name: "Denied" });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.data.error, "WAREHOUSE_WRITE_UNAVAILABLE");
  assert.equal(memory.writes.length, 0);
  assert.equal(
    databaseFixture.requests.filter((entry) => entry.method === "PUT").length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(rejected.data),
    /PRIVATE-|127\.0\.0\.1|credential/,
  );
});

test("archive and reactivation retain inventory, history, identifiers and unknown fields", async () => {
  await write("tenant-fixtures/qa-a/products", {
    main: { p: { quantity: 9 } },
  });
  await write("tenant-fixtures/qa-a/sells", {
    sale: { warehouse: first.name },
  });
  const before = memory.dump();
  const archived = await request("DELETE", "/api/warehouses/original-a", {
    expectedRevision: 0,
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.data.isArchived, true);
  assert.equal(archived.data.data.isActive, false);
  assert.ok(archived.data.data.archivedAt);
  assert.deepEqual(archived.data.data.futureField, first.futureField);
  const writes = memory.writes.length;
  assert.equal(
    (
      await request("DELETE", "/api/warehouses/original-a", {
        expectedRevision: 1,
      })
    ).status,
    200,
  );
  assert.equal(memory.writes.length, writes);
  const restored = await request("PUT", "/api/warehouses/original-a", {
    isActive: true,
    expectedRevision: 1,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.data.isArchived, false);
  assert.equal(restored.data.data.archivedAt, undefined);
  assert.deepEqual(
    memory.dump()["tenant-fixtures"]["qa-a"].products,
    before["tenant-fixtures"]["qa-a"].products,
  );
  assert.deepEqual(
    memory.dump()["tenant-fixtures"]["qa-a"].sells,
    before["tenant-fixtures"]["qa-a"].sells,
  );
  assert.deepEqual(
    memory.dump()["tenant-fixtures"]["qa-b"],
    before["tenant-fixtures"]["qa-b"],
  );
});

test("a tenant writer cannot address roots, other companies or another unit", async () => {
  const database = runWithTenant("qa-a", getTenantDatabase);
  await runWithTenant("qa-b", async () => {
    await assert.rejects(
      database.transact("warehouses/original-a", () => null),
      /TENANT_CONTEXT_MISMATCH/,
    );
  });
  await runWithTenant("qa-a", async () => {
    for (const path of [
      "warehouses",
      "users/owner",
      "accounts/cash",
      "tenant-fixtures/qa-b/warehouses/other",
      "warehouses/original-a/nested",
    ])
      await assert.rejects(
        database.transact(path, () => null),
        /TENANT_WRITE_PATH_NOT_ENABLED/,
      );
  });
  assert.equal(databaseFixture.requests.length, 0);
  await runWithTenant("qa-a", async () => {
    await assert.rejects(
      database.transact("warehouses/original-a", () => null),
      /WAREHOUSE_PHYSICAL_DELETE_DISABLED/,
    );
  });
  assert.equal(memory.writes.length, 0);
});

test("write permissions distinguish viewing, editing, archiving and vehicle management", async () => {
  await write("tenant-fixtures/qa-a/users/worker", {
    username: "worker",
    role: "user",
    permissions: ["warehouses.read"],
  });
  const session = token("qa-a", { userId: "worker", username: "worker" });
  const writes = memory.writes.length;
  assert.equal(
    (await request("POST", "/api/warehouses", { name: "forbidden" }, session))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/warehouses/original-a",
        { location: "forbidden" },
        session,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("DELETE", "/api/warehouses/original-a", {}, session)).status,
    403,
  );
  assert.equal(memory.writes.length, writes);
  await write("tenant-fixtures/qa-a/users/worker/permissions", ["warehouses"]);
  assert.equal(
    (
      await request(
        "PUT",
        "/api/warehouses/original-a",
        { location: "allowed" },
        session,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("DELETE", "/api/warehouses/original-a", {}, session)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/warehouses/original-inactive",
        { location: "forbidden" },
        session,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "PUT",
        "/api/warehouses/original-a",
        { location: "foreign" },
        token("qa-b"),
      )
    ).status,
    404,
  );
});

test("conditional updates preserve Firebase priorities as well as application fields", async () => {
  await write(warehousePath, {
    ...first,
    ".priority": 0,
    name: { ".value": first.name, ".priority": 9 },
    futureField: { preserve: { ".value": true, ".priority": 11 } },
  });
  const result = await request("PUT", "/api/warehouses/original-a", {
    location: "priority-safe",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.data.name, first.name);
  assert.deepEqual(result.data.data.futureField, { preserve: true });
  assert.equal(result.data.data[".priority"], undefined);
  const raw = memory.dump()["tenant-fixtures"]["qa-a"].warehouses["original-a"];
  assert.equal(raw[".priority"], 0);
  assert.equal(raw.name[".priority"], 9);
  assert.equal(raw.futureField.preserve[".priority"], 11);
});

test("vehicle writes use server revisions and stale user profile mirrors cannot retain a managed assignment", async () => {
  const invalid = await request("POST", "/api/vehicles", {
    name: "Unassigned ghost",
    driverId: "unknown-driver",
  });
  assert.equal(invalid.status, 400);
  assert.equal(memory.writes.length, 0);
  for (const id of ["driver-a", "driver-b"])
    await write(`tenant-fixtures/qa-a/users/${id}`, {
      username: id,
      role: "driver",
      permissions: ["driver-sales"],
    });
  const originalProfiles = memory.dump()["tenant-fixtures"]["qa-a"].users;
  const created = await request("POST", "/api/vehicles", {
    name: "Delivery fixture",
    driverId: "driver-a",
    driverName: "driver-a",
  });
  assert.equal(created.status, 200);
  const vehicle = created.data.data;
  assert.equal(vehicle.driverAssignmentManaged, true);
  assert.equal(
    (await request("PUT", `/api/vehicles/${vehicle.id}`, { name: "Renamed" }))
      .status,
    400,
  );
  const a = token("qa-a", { userId: "driver-a", username: "driver-a" });
  const b = token("qa-a", { userId: "driver-b", username: "driver-b" });
  assert.equal(
    (await request("GET", "/api/vehicles/me", undefined, a)).status,
    200,
  );
  const updated = await request("PUT", `/api/vehicles/${vehicle.id}`, {
    driverId: "driver-b",
    driverName: "driver-b",
    expectedRevision: 1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.data.revision, 2);
  assert.deepEqual(
    memory.dump()["tenant-fixtures"]["qa-a"].users,
    originalProfiles,
  );
  await write("tenant-fixtures/qa-a/users/driver-a/vehicleId", vehicle.id);
  assert.equal(
    (await request("GET", "/api/vehicles/me", undefined, a)).status,
    404,
  );
  assert.equal(
    (await request("GET", "/api/vehicles/me", undefined, b)).status,
    200,
  );
  assert.equal(
    (
      await request("PUT", `/api/vehicles/${vehicle.id}`, {
        location: "stale",
        expectedRevision: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("PUT", `/api/vehicles/${vehicle.id}`, {
        driverId: "",
        driverName: "",
        expectedRevision: 2,
      })
    ).status,
    200,
  );
  await write("tenant-fixtures/qa-a/users/driver-b/vehicleId", vehicle.id);
  assert.equal(
    (await request("GET", "/api/vehicles/me", undefined, b)).status,
    404,
  );
});
afterEach(() => {
  for (const peer of peers) peer.disconnect();
  peers.clear();
});
after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => sockets.close(resolve));
  apiServer.closeAllConnections();
  databaseServer.closeAllConnections();
  await new Promise((resolve) => databaseServer.close(resolve));
  restoreDatabaseMock();
});
const write = (target, value) =>
  memory.sdk.set(memory.sdk.ref(null, target), value);
const token = (tenantId = "qa-a", fields = {}) =>
  generateToken({ userId: "owner", username: "owner", tenantId, ...fields });
async function request(method, target, body, session = token()) {
  const response = await fetch(`${apiUrl}${target}`, {
    method,
    headers: {
      Authorization: `Bearer ${session}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
function peer(session = token()) {
  const value = clientSocket(apiUrl, {
    auth: { token: session },
    autoConnect: false,
    forceNew: true,
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
  peers.add(value);
  return value;
}
async function connected(value) {
  const ready = new Promise((resolve, reject) => {
    value.once("connect", resolve);
    value.once("connect_error", reject);
  });
  value.connect();
  await ready;
  return value;
}

test("warehouse API preserves IDs, inactive vehicles and unknown fields while ignoring caller-selected destinations", async () => {
  const before = memory.dump();
  const a = await request(
    "GET",
    "/api/warehouses?tenantId=qa-b&databaseUrl=https://other.invalid",
  );
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, [first, inactive]);
  assert.deepEqual(
    (await request("GET", "/api/warehouses", undefined, token("qa-b"))).data,
    [second],
  );
  assert.deepEqual(memory.dump(), before);
  assert.equal(memory.writes.length, 0);
  assert.ok(remotePaths.includes("tenant-fixtures/qa-a/warehouses"));
  assert.ok(remotePaths.includes("tenant-fixtures/qa-b/warehouses"));
  assert.ok(!remotePaths.includes("tenant-fixtures/qa-a"));
});

test("internal reads use the same repository and preserve missing-record behavior", async () => {
  await runWithTenant("qa-a", async () => {
    assert.deepEqual(await getAllWarehousesInternal(), [first, inactive]);
    assert.deepEqual(await getWarehouseByIdInternal("original-a"), first);
    assert.equal(await getWarehouseByIdInternal("missing"), null);
  });
  assert.equal(memory.writes.length, 0);
  assert.equal(
    memory.reads.length,
    0,
    "The legacy SDK must not supply warehouse reads",
  );
});

test("provider creation requires an active context and handles cannot cross into another company", async () => {
  assert.throws(getTenantDatabase, /TENANT_CONTEXT_REQUIRED/);
  const repository = runWithTenant("qa-a", getWarehouseRepository);
  await assert.rejects(repository.list(), /TENANT_CONTEXT_REQUIRED/);
  await runWithTenant("qa-b", async () => {
    await assert.rejects(repository.list(), /TENANT_CONTEXT_MISMATCH/);
  });
  assert.equal(remotePaths.length, 0);
  const destination = runWithTenant("qa-a", resolveActiveTenant);
  assert.deepEqual(destination, {
    tenantId: "qa-a",
    databaseKey: "shared",
    rootPath: "tenant-fixtures/qa-a",
  });
  assert.equal(Object.isFrozen(destination), true);
});

test("interleaved company reads retain their original contexts across HTTP waits", async () => {
  const read = (tenantId) =>
    runWithTenant(tenantId, async () => {
      const repository = getWarehouseRepository();
      await new Promise((resolve) => setImmediate(resolve));
      return repository.list();
    });
  const [a, b] = await Promise.all([read("qa-a"), read("qa-b")]);
  assert.deepEqual(a, [first, inactive]);
  assert.deepEqual(b, [second]);
});

test("relative paths cannot reach identities, platform data, a foreign prefix or a nested warehouse ID", async () => {
  await runWithTenant("qa-a", async () => {
    const database = getTenantDatabase();
    for (const target of [
      "control/identities/person",
      "users/owner",
      "tenant-fixtures/qa-b/warehouses",
      "trialTenants/qa-b",
      "../qa-b",
      "/warehouses",
    ])
      await assert.rejects(
        database.read(target),
        /RESERVED_TENANT_DATABASE_PATH|INVALID_DATABASE_PATH/,
      );
    await assert.rejects(
      getWarehouseRepository().findById("original-a/private"),
      /INVALID_WAREHOUSE_ID/,
    );
  });
  assert.equal(remotePaths.length, 0);
});

test("permissions are refreshed through REST even if the JavaScript SDK holds a valid old profile", async () => {
  const originalGet = memory.sdk.get;
  memory.sdk.get = async () => {
    throw new Error("Legacy cache must not decide authorization");
  };
  try {
    assert.equal((await request("GET", "/api/warehouses")).status, 200);
    await write("tenant-fixtures/qa-a/users/owner/role", "user");
    assert.equal((await request("GET", "/api/warehouses")).status, 403);
    await write("tenant-fixtures/qa-a/users/owner", null);
    assert.equal((await request("GET", "/api/warehouses")).status, 401);
  } finally {
    memory.sdk.get = originalGet;
  }
});

test("HTTP and login fail closed during a real database connection failure, then recover without changing data", async () => {
  const before = memory.dump();
  assert.equal((await request("GET", "/api/warehouses")).status, 200);
  failure = () => true;
  const failed = await request("GET", "/api/warehouses");
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.data, { error: "AUTH_UNAVAILABLE" });
  const login = await request("POST", "/api/auth/login", {
    companyCode: "qa-a",
    username: "owner",
    password: "local-only",
  });
  assert.equal(login.status, 503);
  assert.doesNotMatch(
    JSON.stringify(login.data),
    /127\.0\.0\.1|password|token/,
  );
  failure = undefined;
  assert.equal((await request("GET", "/api/warehouses")).status, 200);
  assert.deepEqual(memory.dump(), before);
});

test("a central membership and company entitlement are read from the server after every change", async () => {
  await write("tenant-fixtures/qa-a/users/member", {
    username: "member",
    identityId: "identity",
  });
  await write("control/identities/identity", {
    status: "active",
    sessionVersion: "v1",
  });
  await write("control/memberships/qa-a/identity", {
    status: "active",
    userId: "member",
    role: "admin",
    permissions: [],
  });
  const session = generateToken({
    userId: "member",
    username: "member",
    tenantId: "qa-a",
    identityId: "identity",
    sessionVersion: "v1",
  });
  assert.equal(
    (await request("GET", "/api/warehouses", undefined, session)).status,
    200,
  );
  await write("control/memberships/qa-a/identity/status", "revoked");
  assert.equal(
    (await request("GET", "/api/warehouses", undefined, session)).status,
    403,
  );
  assert.equal((await request("GET", "/api/ai/latest")).status, 200);
  await write("control/companies/qa-a/entitlements/ai", false);
  const disabled = await request("GET", "/api/ai/latest");
  assert.equal(disabled.status, 403);
  assert.equal(disabled.data.error, "FEATURE_DISABLED");
  failure = (target) => target === "control/companies/qa-a";
  assert.equal((await request("GET", "/api/warehouses")).status, 503);
});

test("warehouse-only failures are not presented as an empty list and do not expose transport details", async () => {
  failure = (target) => target.endsWith("/warehouses");
  const failed = await request("GET", "/api/warehouses");
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.data, { error: "WAREHOUSE_READ_UNAVAILABLE" });
  failure = undefined;
  await write("tenant-fixtures/qa-a/warehouses", "invalid-store");
  assert.equal((await request("GET", "/api/warehouses")).status, 503);
  await write("tenant-fixtures/qa-a/warehouses", null);
  assert.deepEqual((await request("GET", "/api/warehouses")).data, []);
});

test("a committed server write is visible through the read repository without moving any records", async () => {
  const other = memory.dump()["tenant-fixtures"]["qa-b"];
  const created = await request("POST", "/api/warehouses", {
    name: "New local fixture",
    location: "local",
  });
  assert.equal(created.status, 200);
  const listed = await request("GET", "/api/warehouses");
  assert.deepEqual(
    listed.data.find((item) => item.id === created.data.data.id),
    created.data.data,
  );
  assert.equal(memory.writes.length, 1);
  assert.ok(
    memory.writes[0].path.startsWith("tenant-fixtures/qa-a/warehouses/"),
  );
  assert.deepEqual(memory.dump()["tenant-fixtures"]["qa-b"], other);
  assert.deepEqual(
    memory.dump()["tenant-fixtures"]["qa-a"].warehouses["original-a"],
    first,
  );
});

test(
  "an existing socket disconnects before writing and new connections are denied while the auth store is unreachable",
  { timeout: 5000 },
  async () => {
    const existing = await connected(peer());
    failure = () => true;
    const denied = peer();
    await assert.rejects(connected(denied), /INVALID_SESSION/);
    const disconnected = once(existing, "disconnect");
    existing.emit("invoice-draft:update", { draft: { note: "must not save" } });
    await disconnected;
    assert.equal(memory.writes.length, 0);
    assert.equal(
      memory.dump()["tenant-fixtures"]["qa-a"].invoiceDrafts,
      undefined,
    );
  },
);
