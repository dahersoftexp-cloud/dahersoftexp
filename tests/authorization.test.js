const assert = require("node:assert/strict");
const { test, before, beforeEach, after } = require("node:test");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { scanProject } = require("../scripts/audit-source.cjs");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("./helpers/memory-database");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "isolated-permission-tests-never-deploy";
process.env.TENANTS_ROOT = "tenants";
process.env.DEFAULT_TENANT_ID = "default";
process.env.LEGACY_ROOT_TENANT_ID = "default";
process.env.OPENAI_API_KEY = "synthetic-key";
const owner = { username: "owner", password: "local", role: "admin" };
const memory = createMemoryDatabase({
  tenants: {
    "qa-permissions": {
      users: {
        owner,
        worker: {
          username: "worker",
          password: "local",
          role: "user",
          permissions: [],
        },
      },
      customer: {
        c: {
          id: "c",
          name: "Customer",
          number: "555",
          balance: 789,
          purchases: ["private-invoice"],
          defaultSalesAccountId: "sales",
          futurePrivateField: "private",
        },
      },
      supplier: {
        s: {
          id: "s",
          name: "Supplier",
          balance: 987,
          futurePrivateField: "private",
        },
      },
      accounts: {
        cash: {
          id: "cash",
          name: "Custom cash",
          code: "1000",
          category: "Cash",
          type: "Asset",
          isActive: false,
          currentBalance: 123,
          futurePrivateField: "private",
        },
      },
      products: {
        main: {
          p: {
            id: "p",
            code: "P",
            name: "Product",
            warehouse: "main",
            quantity: 5,
            payPrice: 3,
            sellPrice: 7,
          },
        },
      },
      sells: {
        invoice: {
          id: "invoice",
          products: [
            {
              id: "p",
              code: "P",
              warehouse: "main",
              qty: 1,
              payPrice: 3,
              sellPrice: 7,
            },
          ],
          totalPrice: 7,
        },
      },
      purchases: {
        purchase: {
          id: "purchase",
          code: "P",
          warehouse: "main",
          payPrice: 3,
          totalPrice: 3,
        },
      },
      privateSettings: { apiKey: "PRIVATE-SETTING-SENTINEL" },
      invoiceDrafts: { owner: { note: "PRIVATE-DRAFT-SENTINEL" } },
    },
    "qa-other": {
      users: { owner },
      customer: { other: { name: "OTHER-COMPANY-SENTINEL" } },
    },
  },
});
const { app, generateToken, runWithTenant, restoreDatabaseMock } =
  loadWithMemoryDatabase(memory);
const { apiPolicies, findApiPolicy } = require("../dist/auth/authorization");
const { buildContextPayload } = require("../dist/controllers/aiAsk.controller");
let server, baseUrl;
let aiCalls = [];
let providerFailure = false;
const originalFetch = global.fetch;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (url, options) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      aiCalls.push(JSON.parse(options.body));
      return Promise.resolve(
        providerFailure
          ? new Response("PRIVATE-PROVIDER-ERROR", { status: 500 })
          : new Response(JSON.stringify({ output_text: "Synthetic answer" }), {
              status: 200,
            }),
      );
    }
    assert.equal(
      new URL(url).origin,
      baseUrl,
      "External requests are forbidden",
    );
    return originalFetch(url, options);
  };
});
beforeEach(() => {
  memory.reset();
  aiCalls = [];
  providerFailure = false;
});
after(async () => {
  global.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  restoreDatabaseMock();
});
const token = (userId = "worker", tenantId = "qa-permissions") =>
  generateToken({ userId, username: userId, tenantId });
const write = (target, value) =>
  memory.sdk.set(memory.sdk.ref(null, target), value);
const grant = (...permissions) =>
  write("tenants/qa-permissions/users/worker/permissions", permissions);
async function request(method, target, body, session = token()) {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers: {
      Authorization: `Bearer ${session}`,
      "Content-Type": "application/json",
      "Idempotency-Key": require("node:crypto").randomUUID(),
      "X-Inventory-Role": "admin",
    },
    ...(body === undefined || ["GET", "HEAD"].includes(method)
      ? {}
      : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

test("every declared API has one explicit policy; policy absence, HEAD and Express casing are handled", async () => {
  const routes = scanProject(path.resolve(__dirname, "..")).routes.filter(
    (route) => route.apiPath?.startsWith("/api/"),
  );
  const normalize = (value) => value.replace(/\/$/, "").toLowerCase();
  for (const route of routes) {
    assert.equal(
      apiPolicies.filter(
        (entry) =>
          entry.method === route.method &&
          normalize(entry.path) === normalize(route.apiPath.slice(4)),
      ).length,
      1,
      `${route.method} ${route.apiPath}`,
    );
  }
  assert.ok(
    apiPolicies.every(
      (entry) =>
        entry.public ||
        entry.retired ||
        entry.admin ||
        entry.platform ||
        entry.actions?.length,
    ),
  );
  assert.equal(apiPolicies.length, routes.length);
  assert.equal(findApiPolicy("HEAD", "/PRODUCTS/").path, "/products");
  assert.equal(findApiPolicy("POST", "/products/anything"), undefined);
  assert.equal(
    (await request("GET", "/api/unknown", undefined, token("owner"))).status,
    403,
  );
});

test("business controllers cannot import the root database or direct Firebase database SDK", () => {
  const allowed = new Set([
    "src/tenancy/controlDatabase.ts",
    "src/auth/accounts.ts",
    "src/controllers/trials.controller.ts",
    "src/utils/tenantFirebase.ts",
    "src/firebaseConfig.ts",
  ]);
  const root = path.resolve(__dirname, "..");
  const walk = (directory) =>
    fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((item) =>
        item.isDirectory()
          ? walk(path.join(directory, item.name))
          : [path.join(directory, item.name)],
      );
  for (const file of walk(path.join(root, "src")).filter((file) =>
    file.endsWith(".ts"),
  )) {
    if (allowed.has(path.relative(root, file).replaceAll("\\", "/"))) continue;
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /(?:from\s*["'](?:firebase\/database|[^"']*controlDatabase)["']|\brootRef\b)/,
      file,
    );
  }
});

test("direct server reads and Google credentials remain in the identity/provider infrastructure boundary", () => {
  const inventory = scanProject(path.resolve(__dirname, ".."));
  for (const entry of inventory.serverDatabaseImports) {
    const allowed =
      entry.module === "google-auth-library"
        ? ["src/infrastructure/serverCredentials.ts"]
        : ["src/auth/accounts.ts", "src/tenancy/tenantDatabaseProvider.ts", "src/tenancy/financialUnit.ts"];
    assert.ok(allowed.includes(entry.file), `${entry.file}: ${entry.module}`);
  }
});

test("warehouse and vehicle metadata controllers cannot use legacy SDK warehouse references", () => {
  for (const file of ["warehouses.controller.ts", "vehicles.controller.ts"]) {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/controllers", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /\bWAREHOUSES_PATH\b|ref\(database,\s*["'`]warehouses/,
    );
  }
});

test("a member with no permissions cannot read reports or perform financial and administrative writes", async () => {
  const attempts = [
    ["GET", "/api/sells"],
    ["GET", "/api/payments"],
    ["GET", "/api/journal-entries"],
    ["GET", "/api/users"],
    ["POST", "/api/transactions/sell"],
    ["POST", "/api/transactions/purchase-invoice"],
    ["POST", "/api/transactions/customerPayment"],
    ["POST", "/api/transactions/supplierPayment"],
    ["POST", "/api/transactions/CustomerReturn"],
    ["POST", "/api/transactions/SupplierReturn"],
    ["POST", "/api/transactions/warehouseTransfer"],
    ["POST", "/api/transactions/endExchange"],
    ["POST", "/api/journal-entries/create"],
    ["POST", "/api/material-reservations"],
    ["DELETE", "/api/sells/invoice"],
    ["POST", "/api/currency-migration/run"],
    ["PUT", "/api/invoice-draft/me"],
    ["POST", "/api/vehicles/me/sell"],
  ];
  const initial = memory.dump();
  for (const [method, url] of attempts)
    assert.equal((await request(method, url, {})).status, 403, url);
  assert.deepEqual(memory.dump(), initial);
  assert.equal(memory.writes.length, 0);
});

test("permissions change on an existing token and read permission never authorizes a write", async () => {
  const session = token();
  await grant("sales.read");
  assert.equal(
    (await request("GET", "/api/sells", undefined, session)).status,
    200,
  );
  assert.equal(
    (await request("POST", "/api/transactions/sell", {}, session)).status,
    403,
  );
  await grant();
  assert.equal(
    (await request("GET", "/api/sells", undefined, session)).status,
    403,
  );
  assert.equal(
    (await request("GET", "/api/sells", undefined, token("owner"))).status,
    200,
  );
});

test("seller lookups omit balances, invoices and unknown private fields; customer creation cannot inject financial fields", async () => {
  await grant("sell-product");
  const customers = await request("GET", "/api/customers");
  assert.deepEqual(customers.data, [
    {
      id: "c",
      name: "Customer",
      number: "555",
      defaultSalesAccountId: "sales",
    },
  ]);
  const accounts = await request("GET", "/api/account/get-account");
  assert.deepEqual(accounts.data, [
    {
      id: "cash",
      name: "Custom cash",
      code: "1000",
      category: "Cash",
      type: "Asset",
      isActive: false,
    },
  ]);
  assert.equal(
    (await request("POST", "/api/customers/byId", { id: "c" })).status,
    403,
  );
  assert.equal(
    (await request("GET", "/api/account/get-account/cash")).status,
    403,
  );
  assert.equal(
    (await request("PUT", "/api/customers/c", { name: "Changed" })).status,
    403,
  );
  const created = await request("POST", "/api/customers", {
    name: "New",
    balance: 1000,
    purchases: ["injected"],
    status: "injected",
    futurePrivateField: "injected",
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.data.balance, 0);
  assert.deepEqual(created.data.data.purchases, []);
  assert.equal(created.data.data.futurePrivateField, undefined);
});

test("purchasing lookups omit supplier debt while supplier manager retains its existing view", async () => {
  await grant("purchases");
  assert.deepEqual((await request("GET", "/api/suppliers")).data, [
    { id: "s", name: "Supplier" },
  ]);
  assert.equal((await request("PUT", "/api/suppliers/s", {})).status, 403);
  await grant("suppliers");
  assert.equal((await request("GET", "/api/suppliers")).data[0].balance, 987);
});

test("product details and warehouse queries do not bypass pricing or invoice permissions", async () => {
  await grant("products");
  const detail = await request("POST", "/api/products/byId", { id: "p" });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.product.payPrice, undefined);
  assert.deepEqual(detail.data.purchases, []);
  assert.deepEqual(detail.data.sells, []);
  const warehouse = await request("POST", "/api/products/getByWarehouse", {
    warehouse: "main",
  });
  assert.equal(warehouse.status, 200);
  assert.doesNotMatch(JSON.stringify(warehouse.data), /payPrice|sellPrice/);
  assert.equal((await request("DELETE", "/api/products/p")).status, 403);
  assert.equal(
    (await request("POST", "/api/products/bulk-update-prices", {})).status,
    403,
  );
});

test("retired exports and GET migrations cannot perform reads or writes on company data", async () => {
  memory.reads.length = 0;
  for (const url of ["/api/ai/allData", "/api/warehouses/migrate"])
    assert.equal(
      (await request("GET", url, undefined, token("owner"))).status,
      410,
    );
  assert.equal(memory.writes.length, 0);
  assert.ok(
    memory.reads.every(
      (target) =>
        target.includes("/users/") ||
        target.startsWith("control/") ||
        target.startsWith("trialTenants/"),
    ),
  );
});

test("account reads preserve historical data and explicit bootstrap only adds missing accounts", async () => {
  const before = memory.dump();
  assert.equal(
    (
      await request(
        "GET",
        "/api/account/get-account",
        undefined,
        token("owner"),
      )
    ).status,
    200,
  );
  assert.deepEqual(memory.dump(), before);
  assert.equal(memory.writes.length, 0);
  assert.equal(
    (await request("POST", "/api/account/initialize-defaults", {})).status,
    403,
  );
  const initialized = await request(
    "POST",
    "/api/account/initialize-defaults",
    {},
    token("owner"),
  );
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.created.length, 9);
  assert.deepEqual(
    memory.dump().tenants["qa-permissions"].accounts.cash,
    before.tenants["qa-permissions"].accounts.cash,
  );
  assert.equal(
    memory.dump().tenants["qa-permissions"].accounts["default-cash"],
    undefined,
  );
  assert.deepEqual(
    memory.dump().tenants["qa-other"],
    before.tenants["qa-other"],
  );
  const writes = memory.writes.length;
  assert.deepEqual(
    (
      await request(
        "POST",
        "/api/account/initialize-defaults",
        {},
        token("owner"),
      )
    ).data.created,
    [],
  );
  // A new command with no new accounts still records its replay result atomically.
  assert.equal(memory.writes.length, writes + 1);
});

test("AI requires both action permission and an explicit entitlement, even for a company admin", async () => {
  assert.equal(
    (await request("POST", "/api/ai/ask", { question: "summary" })).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/api/ai/ask",
        { question: "summary" },
        token("owner"),
      )
    ).status,
    403,
  );
  await write("control/companies/qa-permissions", {
    status: "active",
    entitlements: { ai: true },
  });
  assert.equal(
    (await request("POST", "/api/ai/ask", { question: "summary" })).status,
    403,
  );
  assert.equal(aiCalls.length, 0);
});

test("AI uses allowlisted business data, bounds its UTF-8 context and does not expose provider errors", async () => {
  await write("control/companies/qa-permissions", {
    status: "active",
    entitlements: { ai: true },
  });
  memory.reads.length = 0;
  const result = await request(
    "POST",
    "/api/ai/ask",
    { question: "summary" },
    token("owner"),
  );
  assert.equal(result.status, 200);
  assert.equal(aiCalls.length, 1);
  assert.doesNotMatch(
    JSON.stringify(aiCalls),
    /PRIVATE-|OTHER-COMPANY|password|futurePrivateField|\b555\b/,
  );
  assert.ok(!memory.reads.includes("tenants/qa-permissions"));
  assert.ok(!memory.reads.includes("tenants/qa-other"));
  assert.equal(memory.dump().tenants["qa-other"].ai, undefined);
  const context = runWithTenant("qa-permissions", () =>
    buildContextPayload({
      products: { main: { long: { name: "ض".repeat(100000), quantity: 1 } } },
    }),
  );
  assert.ok(Buffer.byteLength(context, "utf8") <= 60000);
  assert.doesNotThrow(() => JSON.parse(context));
  providerFailure = true;
  const failed = await request(
    "POST",
    "/api/ai/ask",
    { question: "summary" },
    token("owner"),
  );
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(failed.data), /PRIVATE-|synthetic-key/);
  assert.equal(
    (
      await request(
        "POST",
        "/api/ai/ask",
        { question: "x".repeat(2001) },
        token("owner"),
      )
    ).status,
    413,
  );
});

test("AI rejects an oversized source before contacting the provider", async () => {
  await write("control/companies/qa-permissions", {
    status: "active",
    entitlements: { ai: true },
  });
  await write(
    "tenants/qa-permissions/customer/c/unknown",
    "x".repeat(5 * 1024 * 1024),
  );
  const result = await request(
    "POST",
    "/api/ai/ask",
    { question: "summary" },
    token("owner"),
  );
  assert.equal(result.status, 413);
  assert.equal(result.data.error, "AI_SOURCE_TOO_LARGE");
  assert.equal(aiCalls.length, 0);
});

test("AI limits concurrent work and request count independently for each company", () => {
  const { acquireAiSlot } = require("../dist/auth/aiLimits");
  const release = acquireAiSlot("qa-rate-limit");
  assert.throws(() => acquireAiSlot("qa-rate-limit"), /AI_RATE_LIMIT/);
  const other = acquireAiSlot("qa-rate-other");
  other();
  release();
  for (let i = 0; i < 4; i++) acquireAiSlot("qa-rate-limit")();
  assert.throws(() => acquireAiSlot("qa-rate-limit"), /AI_RATE_LIMIT/);
});

test("legacy role defaults only apply when permissions are absent; an explicit empty list grants nothing", async () => {
  await write("tenants/qa-permissions/users/worker/permissions", null);
  const legacy = await request("POST", "/api/auth/login", {
    username: "worker",
    password: "local",
    companyCode: "qa-permissions",
  });
  assert.deepEqual(legacy.data.user.permissions, [
    "home",
    "dashboard",
    "products",
  ]);
  await grant();
  assert.equal((await request("GET", "/api/products")).status, 403);
});
