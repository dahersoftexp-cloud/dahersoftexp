const assert = require("node:assert/strict");
const { test, before, beforeEach, after } = require("node:test");
const { once } = require("node:events");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("./helpers/memory-database");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-baseline-test-secret-never-for-deployment";
process.env.DEFAULT_TENANT_ID = "default";
process.env.TENANTS_ROOT = "tenants";

const account = (id, nature, type) => ({
  id,
  name: id,
  nature,
  type,
  currency: "USD",
  allowTransactions: true,
  isActive: true,
  openingBalance: 0,
  currentBalance: 0,
  currentBalanceUSD: 0,
  currentBalanceSYP: 0,
});
function fixture() {
  return {
    users: {
      "synthetic-user": {
        username: "synthetic-user",
        password: "local-only",
        role: "admin",
      },
    },
    accounts: {
      cash: account("cash", "Debit", "Asset"),
      receivable: account("receivable", "Debit", "Asset"),
      sales: account("sales", "Credit", "Revenue"),
    },
    products: {
      main: {
        "product-1": {
          id: "product-1",
          code: "P1",
          name: "Synthetic product",
          warehouse: "main",
          quantity: 50,
          reservedQuantity: 0,
          payPrice: 4,
          sellPrice: 10,
        },
      },
    },
    customer: {
      "customer-1": {
        id: "customer-1",
        name: "Synthetic customer",
        balance: 0,
        balanceUSD: 0,
        balanceSYP: 0,
        purchases: [],
      },
    },
  };
}
const secondTenant = fixture();
const memory = createMemoryDatabase({
  users: { sentinel: { role: "admin" } },
  tenants: {
    "qa-a": fixture(),
    "qa-b": secondTenant,
  },
});
const {
  app,
  generateToken,
  runWithTenant,
  getTenantDatabasePath,
  restoreDatabaseMock,
} = loadWithMemoryDatabase(memory);
const originalFetch = global.fetch;
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // AI endpoints and accidental test changes cannot use fetch off this server.
  global.fetch = (url, options) => {
    assert.equal(
      new URL(url).origin,
      baseUrl,
      "External network is forbidden in baseline tests",
    );
    return originalFetch(url, options);
  };
});
after(async () => {
  global.fetch = originalFetch;
  try {
    if (server) {
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    }
  } finally {
    restoreDatabaseMock();
  }
});
beforeEach(() => memory.reset());

async function request(tenant, method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": require("node:crypto").randomUUID(),
      Authorization: `Bearer ${generateToken({ userId: "synthetic-user", username: "synthetic-user", tenantId: tenant, role: "admin" })}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function sale(paymentStatus = "cash") {
  return {
    customerId: "customer-1",
    products: [
      {
        id: "product-1",
        code: "P1",
        warehouse: "main",
        qty: 2,
        quantity: 50,
        sellPrice: 10,
        payPrice: 4,
        name: "Synthetic product",
        selectedPriceType: "sellPrice",
      },
    ],
    paymentStatus,
    paymentAccountId: "cash",
    salesAccountId: "sales",
    receivableAccountId: "receivable",
    currency: "USD",
    exchangeRate: 1,
    totalPrice: 20,
    remainingDebt: paymentStatus === "debt" ? 20 : 0,
    amount_base: 20,
  };
}
function assertOtherTenantUntouched() {
  assert.deepEqual(memory.dump().tenants["qa-b"], secondTenant);
  assert.deepEqual(memory.dump().users, { sentinel: { role: "admin" } });
  assert.ok(
    memory.writes.every(
      (entry) =>
        entry.path === "tenants/qa-a" || entry.path.startsWith("tenants/qa-a/"),
    ),
  );
}

test("baseline: successful cash sale stores expected stock, customer, ledger, journal and payment effects", async () => {
  const response = await request("qa-a", "POST", "/api/transactions/sell", {
    newSell: sale(),
  });
  assert.equal(response.status, 200);
  const stored = memory.dump().tenants["qa-a"];
  const invoice = response.data.data;
  assert.equal(stored.products.main["product-1"].quantity, 48);
  assert.equal(stored.sells[invoice.id].totalUSD, 20);
  assert.equal(stored.customer["customer-1"].balanceUSD, 0);
  assert.equal(stored.accounts.cash.currentBalanceUSD, 20);
  assert.equal(stored.accounts.sales.currentBalanceUSD, 20);
  const journals = Object.values(stored.journalEntries);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].referenceId, invoice.id);
  assert.equal(
    journals[0].lines.reduce((sum, line) => sum + line.debit - line.credit, 0),
    0,
  );
  assert.equal(
    Object.values(stored.payment).filter(
      (payment) => payment.sellId === invoice.id,
    ).length,
    1,
  );
  const foreignRead = await request("qa-b", "GET", `/api/sells/${invoice.id}`);
  assert.equal(foreignRead.status, 404);
  assertOtherTenantUntouched();
});

test("a cashier can sell through its assigned page permission and loses write access immediately after revocation", async () => {
  await memory.sdk.update(
    memory.sdk.ref(null, "tenants/qa-a/users/synthetic-user"),
    { role: "user", permissions: ["sell-product"] },
  );
  const allowed = await request("qa-a", "POST", "/api/transactions/sell", {
    newSell: sale(),
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    memory.dump().tenants["qa-a"].products.main["product-1"].quantity,
    48,
  );
  await memory.sdk.update(
    memory.sdk.ref(null, "tenants/qa-a/users/synthetic-user"),
    { permissions: [] },
  );
  const before = memory.dump();
  const denied = await request("qa-a", "POST", "/api/transactions/sell", {
    newSell: sale(),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(memory.dump(), before);
  assertOtherTenantUntouched();
});

test("baseline: debt sale followed by payment reconciles invoice, customer and receivable", async () => {
  const response = await request("qa-a", "POST", "/api/transactions/sell", {
    newSell: sale("debt"),
  });
  assert.equal(response.status, 200);
  const invoice = response.data.data;
  const payment = await request(
    "qa-a",
    "POST",
    "/api/transactions/customerPayment",
    {
      paymentData: {
        type: "income",
        customerId: "customer-1",
        sellId: invoice.id,
        amount: 10,
        amountUSD: 10,
        amountOriginal: 10,
        amount_base: 10,
        paymentAccountId: "cash",
        receivableAccountId: "receivable",
        currency: "USD",
        exchangeRate: 1,
      },
    },
  );
  assert.equal(payment.status, 200);
  const stored = memory.dump().tenants["qa-a"];
  assert.equal(stored.sells[invoice.id].remainingUSD, 10);
  assert.equal(stored.customer["customer-1"].balanceUSD, -10);
  assert.equal(stored.accounts.receivable.currentBalanceUSD, 10);
  assert.equal(stored.accounts.cash.currentBalanceUSD, 10);
  assert.equal(stored.accounts.sales.currentBalanceUSD, 20);
  assertOtherTenantUntouched();
});

test("baseline: report endpoints expose stored journal and account data for the selected signed tenant", async () => {
  await request("qa-a", "POST", "/api/transactions/sell", { newSell: sale() });
  const response = await request("qa-a", "GET", "/api/journal-entries");
  assert.equal(response.status, 200);
  assert.equal(response.data.length, 1);
  assert.ok(
    response.data.every(
      (entry) =>
        entry.lines.reduce((sum, line) => sum + line.debit - line.credit, 0) ===
        0,
    ),
  );
  const accounts = await request("qa-a", "GET", "/api/account/get-account");
  assert.equal(accounts.status, 200);
  assert.equal(
    accounts.data.find((entry) => entry.id === "cash").currentBalanceUSD,
    20,
  );
  const foreign = await request("qa-b", "GET", "/api/journal-entries");
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign.data, []);
  assertOtherTenantUntouched();
});

test("baseline: invalid account fails sale before any writes", async () => {
  const before = memory.dump();
  const response = await request("qa-a", "POST", "/api/transactions/sell", {
    newSell: { ...sale(), salesAccountId: "missing" },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(memory.dump(), before);
});

test("baseline: warehouse transfer preserves total quantity and stores movement within the tenant", async () => {
  const response = await request(
    "qa-a",
    "POST",
    "/api/transactions/warehouseTransfer",
    {
      transferData: {
        productId: "product-1",
        oldWarehouse: "main",
        newWarehouse: "secondary",
        quantity: 3,
        amount: 0,
        amount_base: 0,
        currency: "USD",
        exchangeRate: 1,
        note: "Synthetic transfer",
      },
    },
  );
  assert.equal(response.status, 200);
  const stored = memory.dump().tenants["qa-a"];
  assert.equal(stored.products.main["product-1"].quantity, 47);
  assert.equal(
    Object.values(stored.products.secondary).reduce(
      (sum, product) => sum + product.quantity,
      0,
    ),
    3,
  );
  assert.equal(Object.values(stored.warehouseTransfers).length, 1);
  assertOtherTenantUntouched();
});

test("tenant context survives interleaved asynchronous operations without sharing active tenant", async () => {
  const results = await Promise.all(
    ["qa-a", "qa-b"].map((tenant) =>
      runWithTenant(tenant, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return getTenantDatabasePath("sells/known-id");
      }),
    ),
  );
  assert.deepEqual(results, [
    "tenants/qa-a/sells/known-id",
    "tenants/qa-b/sells/known-id",
  ]);
});
