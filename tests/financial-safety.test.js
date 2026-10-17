const assert = require("node:assert/strict");
const { test, before, beforeEach, after } = require("node:test");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("./helpers/memory-database");
const { companyFixture, sale } = require("./helpers/financial-fixture");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-financial-regression-secret-not-for-deployment";
process.env.TENANTS_ROOT = "tenants";
const memory = createMemoryDatabase({
  tenants: {
    "qa-financial": companyFixture(),
    "qa-neighbor": companyFixture(),
  },
  control: { sentinel: true },
});
let commitMode;
let commitCalls;
const loaded = loadWithMemoryDatabase(memory, {
  serverCompareAndSet: async (...args) => {
    commitCalls++;
    if (commitMode === "reject") return false;
    const committed = await memory.serverCompareAndSet(...args);
    if (commitMode === "lost" && committed) {
      commitMode = undefined;
      throw new Error("SIMULATED_LOST_ACK");
    }
    return committed;
  },
});
let server, origin;
const originalFetch = global.fetch;
before(async () => {
  server = loaded.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (url, options) => {
    assert.equal(new URL(url).origin, origin);
    return originalFetch(url, options);
  };
});
after(async () => {
  global.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  loaded.restoreDatabaseMock();
});
beforeEach(() => {
  memory.reset();
  commitMode = undefined;
  commitCalls = 0;
});
const company = () => memory.dump().tenants["qa-financial"];
const request = async (path, body, key = randomUUID(), method = "POST") => {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      Authorization: `Bearer ${loaded.generateToken({ userId: "owner", username: "owner", tenantId: "qa-financial" })}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
};
test("financial HTTP requires a durable key before writing", async () => {
  const before = memory.dump();
  assert.equal(
    (await request("/transactions/sell", { newSell: sale() }, "")).status,
    400,
  );
  assert.deepEqual(memory.dump(), before);
});
test("same-key concurrent sale commits invoice, stock, payment and ledger exactly once", async () => {
  const key = randomUUID();
  const before = memory.dump();
  const [a, b] = await Promise.all([
    request("/transactions/sell", { newSell: sale() }, key),
    request("/transactions/sell", { newSell: sale() }, key),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(b, a);
  const saved = company();
  assert.equal(saved.products.main.p1.quantity, 48);
  for (const collection of [
    "sells",
    "payment",
    "journalEntries",
    "_financialOperations",
  ])
    assert.equal(Object.keys(saved[collection]).length, 1);
  assert.equal(saved.accounts.cash.currentBalanceUSD, 20);
  assert.equal(saved.accounts.sales.currentBalanceUSD, 20);
  assert.deepEqual(
    memory.dump().tenants["qa-neighbor"],
    before.tenants["qa-neighbor"],
  );
  assert.deepEqual(
    saved.customSetting,
    before.tenants["qa-financial"].customSetting,
  );
  assert.ok(
    memory.writes.every(
      (write) =>
        write.operation === "server-put" &&
        write.path === "tenants/qa-financial",
    ),
  );
});
test("a key cannot be reused for a different command", async () => {
  const key = randomUUID();
  assert.equal(
    (await request("/transactions/sell", { newSell: sale() }, key)).status,
    200,
  );
  const before = memory.dump();
  const changed = sale();
  changed.products[0].qty = 3;
  const response = await request(
    "/transactions/sell",
    { newSell: changed },
    key,
  );
  assert.equal(response.status, 409);
  assert.equal(response.data.error, "IDEMPOTENCY_KEY_REUSED");
  assert.deepEqual(memory.dump(), before);
});
test("different concurrent sales preserve both stock and account movements", async () => {
  const results = await Promise.all([
    request("/transactions/sell", { newSell: sale() }),
    request("/transactions/sell", { newSell: sale() }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.equal(company().products.main.p1.quantity, 46);
  assert.equal(company().accounts.cash.currentBalanceUSD, 40);
});
test("lost acknowledgement is not retried automatically and same-key replay finds committed result", async () => {
  commitMode = "lost";
  const key = randomUUID();
  assert.equal(
    (await request("/transactions/sell", { newSell: sale() }, key)).status,
    503,
  );
  assert.equal(commitCalls, 1);
  assert.equal(company().products.main.p1.quantity, 48);
  const replay = await request("/transactions/sell", { newSell: sale() }, key);
  assert.equal(replay.status, 200);
  assert.equal(commitCalls, 1);
  assert.equal(Object.keys(company().sells).length, 1);
});
test("a late stock failure rolls back every staged product and document", async () => {
  const command = sale();
  command.products = [
    { ...command.products[0], qty: 30 },
    { ...command.products[0], qty: 30 },
  ];
  const before = memory.dump();
  assert.equal(
    (await request("/transactions/sell", { newSell: command })).status,
    400,
  );
  assert.deepEqual(memory.dump(), before);
  assert.equal(commitCalls, 0);
});
test("negative, zero and non-finite sale quantities are rejected without writes", async () => {
  for (const qty of [-1, 0, "invalid"]) {
    const command = sale();
    command.products.push({ ...command.products[0], qty });
    assert.equal(
      (await request("/transactions/sell", { newSell: command })).status,
      400,
    );
    assert.equal(memory.writes.length, 0);
  }
});
test("invalid payment account cannot partially settle a debt invoice", async () => {
  const created = await request("/transactions/sell", {
    newSell: sale("debt"),
  });
  assert.equal(created.status, 200);
  const before = memory.dump();
  const result = await request("/transactions/customerPayment", {
    paymentData: {
      customerId: "c1",
      sellId: created.data.data.id,
      amount: 5,
      amountUSD: 5,
      amount_base: 5,
      currency: "USD",
      exchangeRate: 1,
      paymentAccountId: "missing",
      receivableAccountId: "receivable",
      type: "income",
    },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(memory.dump(), before);
});
test("manual journal posts balances and uses the authenticated actor", async () => {
  const result = await request("/journal-entries/create", {
    journalEntry: {
      description: "Manual posting",
      createdBy: "spoofed",
      lines: [
        { accountId: "cash", debit: 10, credit: 0 },
        { accountId: "sales", debit: 0, credit: 10 },
      ],
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.createdBy, "owner");
  assert.equal(company().accounts.cash.currentBalanceUSD, 10);
  assert.equal(company().accounts.sales.currentBalanceUSD, 10);
});
test("balanced negative or unknown-account journals cannot be saved", async () => {
  for (const lines of [
    [
      { accountId: "cash", debit: -10, credit: 0 },
      { accountId: "sales", debit: 0, credit: -10 },
    ],
    [
      { accountId: "missing", debit: 10, credit: 0 },
      { accountId: "sales", debit: 0, credit: 10 },
    ],
  ]) {
    assert.equal(
      (
        await request("/journal-entries/create", {
          journalEntry: { description: "Invalid", lines },
        })
      ).status,
      400,
    );
    assert.equal(memory.writes.length, 0);
  }
});
test("posted invoices and direct account balances cannot be changed or deleted", async () => {
  const created = await request("/transactions/sell", { newSell: sale() });
  const before = memory.dump();
  for (const method of ["PUT", "DELETE"])
    assert.equal(
      (
        await request(
          `/sells/${created.data.data.id}`,
          { data: sale() },
          randomUUID(),
          method,
        )
      ).status,
      409,
    );
  assert.equal(
    (
      await request(
        "/account/update-account/cash",
        { currentBalance: 999 },
        randomUUID(),
        "PUT",
      )
    ).status,
    409,
  );
  assert.deepEqual(memory.dump(), before);
});
test("missing transfer product is a failure, and generic returns cannot bypass accounting", async () => {
  const before = memory.dump();
  assert.equal(
    (
      await request("/transactions/warehouseTransfer", {
        transferData: {
          productId: "missing",
          quantity: 1,
          oldWarehouse: "main",
          newWarehouse: "second",
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/returns", {
        productId: "p1",
        warehouse: "main",
        qty: 1,
        type: "customer",
      })
    ).status,
    409,
  );
  assert.deepEqual(memory.dump(), before);
});
test("bounded definitive conflicts do not persist partial writes", async () => {
  commitMode = "reject";
  const before = memory.dump();
  const result = await request("/transactions/sell", { newSell: sale() });
  assert.equal(result.status, 409);
  assert.equal(commitCalls, 5);
  assert.deepEqual(memory.dump(), before);
});
test("posting imbalance and reserved-path writes fail closed at the unit boundary", async () => {
  const { runFinancialCommand } = require("../dist/tenancy/financialUnit");
  const { set, ref } = require("../dist/utils/tenantFirebase");
  const before = memory.dump();
  await loaded.runWithTenant("qa-financial", async () => {
    await assert.rejects(
      runFinancialCommand(
        { key: randomUUID(), kind: "test", actorId: "owner", body: {} },
        async () => {
          await set(ref("accounts/cash/currentBalanceUSD"), 999);
          return {};
        },
      ),
      /LEDGER_JOURNAL_MISMATCH/,
    );
    await assert.rejects(
      runFinancialCommand(
        { key: randomUUID(), kind: "test", actorId: "owner", body: {} },
        async () => {
          await set(ref("users/owner/role"), "admin");
          return {};
        },
      ),
      /FINANCIAL_WRITE_PATH_FORBIDDEN/,
    );
  });
  assert.deepEqual(memory.dump(), before);
});

test("injected failure on the second account discards staged invoice, stock and first balance", async () => {
  const adapter = require("../dist/utils/tenantFirebase");
  const original = adapter.runTransaction;
  const before = memory.dump();
  adapter.runTransaction = async (target, ...args) => {
    if (target.key === "sales")
      throw new Error("INJECTED_SECOND_ACCOUNT_FAILURE");
    return original(target, ...args);
  };
  try {
    assert.equal(
      (await request("/transactions/sell", { newSell: sale() })).status,
      400,
    );
  } finally {
    adapter.runTransaction = original;
  }
  assert.deepEqual(memory.dump(), before);
  assert.equal(commitCalls, 0);
});
test("injected second-product failure discards the first staged stock adjustment", async () => {
  await memory.sdk.set(
    memory.sdk.ref(null, "tenants/qa-financial/products/main/p2"),
    { ...companyFixture().products.main.p1, id: "p2", code: "P2" },
  );
  const adapter = require("../dist/utils/tenantFirebase");
  const original = adapter.runTransaction;
  const before = memory.dump();
  const command = sale();
  command.products.push({ ...command.products[0], id: "p2", code: "P2" });
  adapter.runTransaction = async (target, ...args) => {
    if (target.key === "p2") throw new Error("INJECTED_SECOND_PRODUCT_FAILURE");
    return original(target, ...args);
  };
  try {
    assert.equal(
      (await request("/transactions/sell", { newSell: command })).status,
      400,
    );
  } finally {
    adapter.runTransaction = original;
  }
  assert.deepEqual(memory.dump(), before);
  assert.equal(commitCalls, 0);
});
test("manual currency metadata matches the balances and decimal sums balance at three places", async () => {
  const result = await request("/journal-entries/create", {
    journalEntry: {
      description: "Fractional journal",
      lines: [
        {
          accountId: "cash",
          debit: 0.1,
          credit: 0,
          currency: "SYP",
          exchangeRate: 10000,
        },
        {
          accountId: "cash",
          debit: 0.2,
          credit: 0,
          currency: "SYP",
          exchangeRate: 10000,
        },
        {
          accountId: "sales",
          debit: 0,
          credit: 0.3,
          currency: "SYP",
          exchangeRate: 10000,
        },
      ],
    },
  });
  assert.equal(result.status, 201);
  assert.equal(company().accounts.cash.currentBalanceUSD, 0.3);
  assert.equal(company().accounts.cash.currentBalanceSYP, 3000);
  assert.equal(company().accounts.sales.currentBalanceSYP, 3000);
});
test("purchase API uses the financial workflow and computes rather than trusting invoice total", async () => {
  const result = await request("/purchases", {
    supplierId: "s1",
    products: [
      {
        name: "Test product",
        code: "P1",
        warehouse: "main",
        quantity: 2,
        payPrice: 4,
        sellPrice: 10,
      },
    ],
    totalPrice: 999,
    paymentStatus: "cash",
    inventoryAccountId: "inventory",
    payableAccountId: "payable",
    paymentAccountId: "cash",
    currency: "USD",
    exchangeRate: 1,
  });
  assert.equal(result.status, 200);
  assert.equal(Object.keys(company().purchases).length, 1);
  assert.equal(company().accounts.inventory.currentBalanceUSD, 8);
  assert.equal(company().accounts.cash.currentBalanceUSD, -8);
  assert.equal(Object.keys(company().journalEntries).length, 1);
});
test("account archival preserves its balance and journal references", async () => {
  await request("/transactions/sell", { newSell: sale() });
  const result = await request(
    "/account/delete-account/cash",
    {},
    randomUUID(),
    "DELETE",
  );
  assert.equal(result.status, 200);
  assert.equal(company().accounts.cash.currentBalanceUSD, 20);
  assert.equal(company().accounts.cash.isActive, false);
  assert.equal(Object.keys(company().journalEntries).length, 1);
  assert.equal(
    (await request("/transactions/sell", { newSell: sale() })).status,
    400,
  );
});
test("business reads are fresh and financial SDK writes outside a command are rejected", async () => {
  const { get, set, ref } = require("../dist/utils/tenantFirebase");
  let captured;
  await loaded.runWithTenant("qa-financial", async () => {
    captured = ref("products/main/p1");
    assert.equal((await get(captured)).val().quantity, 50);
    await assert.rejects(set(captured, {}), /FINANCIAL_UNIT_REQUIRED/);
    assert.ok(
      memory.serverReads.includes("tenants/qa-financial/products/main/p1"),
    );
  });
  await loaded.runWithTenant("qa-neighbor", async () => {
    await assert.rejects(get(captured), /CROSS_TENANT_PATH/);
  });
});
test("invalid journal dates are rejected before any financial write", async () => {
  for (const date of ["invalid-date", "2026-02-30"]) {
    const result = await request("/journal-entries/create", {
      journalEntry: {
        date,
        description: "Invalid date",
        lines: [
          { accountId: "cash", debit: 1, credit: 0 },
          { accountId: "sales", debit: 0, credit: 1 },
        ],
      },
    });
    assert.equal(result.status, 400);
    assert.equal(memory.writes.length, 0);
  }
});
