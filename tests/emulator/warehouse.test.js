const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const {
  createServerDatabaseClient,
} = require("../../dist/infrastructure/serverDatabase");
const {
  createMemoryDatabase,
  loadWithMemoryDatabase,
} = require("../helpers/memory-database");

// No .env, production URL or real credentials are used in this entry point.
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!host || !/^127\.0\.0\.1:\d+$/.test(host))
  throw new Error(
    "An explicit loopback FIREBASE_DATABASE_EMULATOR_HOST is required.",
  );
if (
  process.env.GCLOUD_PROJECT &&
  process.env.GCLOUD_PROJECT !== "demo-dahersoft-warehouse"
)
  throw new Error("Warehouse emulator tests require the demo project.");
const namespace = "demo-dahersoft-warehouse-default-rtdb";
const baseUrl = `http://${host}`;
let afterResponse;
const network = async (value, options) => {
  const url = new URL(value);
  assert.equal(url.origin, baseUrl);
  url.searchParams.set("ns", namespace);
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: options?.signal || AbortSignal.timeout(8000),
  });
  await afterResponse?.(url, options, response);
  return response;
};
const client = createServerDatabaseClient({
  baseUrl,
  allowLoopback: true,
  fetch: network,
});
process.env.TENANTS_ROOT = "tenant-fixtures";
process.env.NODE_ENV = "test";
let barrierHook;
const { runWithTenant, restoreDatabaseMock } = loadWithMemoryDatabase(
  createMemoryDatabase(),
  {
    serverReader: client.read,
    serverVersionedReader: async (path) => {
      const revision = await client.readVersioned(path);
      await barrierHook?.(path);
      return revision;
    },
    serverCompareAndSet: client.compareAndSet,
  },
);
const {
  getWarehouseRepository,
} = require("../../dist/repositories/warehouses.repository");
after(restoreDatabaseMock);
const tenantId = () => `qa-warehouse-${randomUUID()}`;

const { companyFixture, sale } = require("../helpers/financial-fixture");
const { runFinancialCommand } = require("../../dist/tenancy/financialUnit");
const { handleSell } = require("../../dist/functions/transactions");
const seedFinancialCompany = async () => {
  const company = tenantId();
  const response = await network(`${baseUrl}/tenant-fixtures/${company}.json`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(companyFixture()),
  });
  assert.equal(response.status, 200); await response.arrayBuffer();
  return company;
};
const sellCommand = (key, newSell = sale()) => runFinancialCommand({ key, kind: "emulator:sell", actorId: "owner", body: newSell }, () => handleSell({ newSell }));

test("real RTDB financial root conflicts preserve two sales and duplicate keys have one effect", async () => {
  const company = await seedFinancialCompany();
  await runWithTenant(company, async () => {
    let arrivals = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    barrierHook = async path => {
      if (path !== `tenant-fixtures/${company}` || arrivals >= 2) return;
      if (++arrivals === 2) release();
      await barrier;
    };
    const key = randomUUID();
    try {
      const results = await Promise.all([sellCommand(key), sellCommand(key)]);
      assert.equal(results[0].id, results[1].id);
    } finally { barrierHook = undefined; }
    await Promise.all([sellCommand(randomUUID()), sellCommand(randomUUID())]);
    const saved = await client.read(`tenant-fixtures/${company}`);
    assert.equal(saved.products.main.p1.quantity, 44);
    assert.equal(saved.accounts.cash.currentBalanceUSD, 60);
    assert.equal(saved.accounts.sales.currentBalanceUSD, 60);
    for (const path of ["sells", "journalEntries", "payment", "_financialOperations"]) assert.equal(Object.keys(saved[path]).length, 3);
    assert.deepEqual(saved.customSetting, companyFixture().customSetting);
  });
});
test("real RTDB financial failure leaves the whole company unchanged", async () => {
  const company = await seedFinancialCompany();
  await runWithTenant(company, async () => {
    const before = await client.read(`tenant-fixtures/${company}`);
    const command = sale(); command.products = [{ ...command.products[0], qty: 30 }, { ...command.products[0], qty: 30 }];
    await assert.rejects(sellCommand(randomUUID(), command));
    assert.deepEqual(await client.read(`tenant-fixtures/${company}`), before);
  });
});
test("real committed financial PUT with lost acknowledgement is found by replay", async () => {
  const company = await seedFinancialCompany();
  const key = randomUUID();
  await runWithTenant(company, async () => {
    afterResponse = async (url, options, response) => {
      if (options?.method === "PUT" && url.pathname === `/tenant-fixtures/${company}.json` && response.status === 200) {
        afterResponse = undefined; await response.arrayBuffer(); throw new Error("SIMULATED_LOST_FINANCIAL_ACK");
      }
    };
    try { await assert.rejects(sellCommand(key), /SERVER_DATABASE_WRITE_OUTCOME_UNKNOWN/); }
    finally { afterResponse = undefined; }
    await sellCommand(key);
    const saved = await client.read(`tenant-fixtures/${company}`);
    assert.equal(saved.products.main.p1.quantity, 48);
    assert.equal(Object.keys(saved.sells).length, 1);
    assert.equal(saved.accounts.cash.currentBalanceUSD, 20);
  });
});

test("real RTDB emulator accepts conditional writes and returns conflicts instead of losing edits", async () => {
  await runWithTenant(tenantId(), async () => {
    const repository = getWarehouseRepository();
    const record = await repository.create({
      name: "Concurrent emulator fixture",
      isActive: true,
    });
    let arrivals = 0;
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    barrierHook = async (path) => {
      if (!path.endsWith(record.id) || arrivals >= 2) return;
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    };
    try {
      await Promise.all([
        repository.update(record.id, { location: "A" }),
        repository.update(record.id, { isActive: false }),
      ]);
    } finally {
      barrierHook = undefined;
    }
    const saved = await repository.findById(record.id);
    assert.equal(saved.location, "A");
    assert.equal(saved.isActive, false);
    assert.equal(saved.revision, 3);
    await assert.rejects(
      repository.update(
        record.id,
        { location: "stale" },
        { expectedRevision: 1 },
      ),
      { code: "WAREHOUSE_CONFLICT" },
    );
  });
});

test("real RTDB emulator stores one record for concurrent normalized-name creations", async () => {
  await runWithTenant(tenantId(), async () => {
    const repository = getWarehouseRepository();
    const results = await Promise.allSettled([
      repository.create({ name: "Shared name", isActive: true }),
      repository.create({ name: " shared NAME ", isActive: true }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal((await repository.list()).length, 1);
  });
});

test("real RTDB export/ETag requests preserve priority metadata and archive without deletion", async () => {
  const company = tenantId();
  const path = `tenant-fixtures/${company}/warehouses/legacy`;
  const seeded = await network(`${baseUrl}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "legacy",
      name: { ".value": "Legacy", ".priority": 5 },
      isActive: true,
      ".priority": 0,
      custom: { preserved: true },
    }),
  });
  assert.equal(seeded.status, 200);
  await seeded.arrayBuffer();
  await runWithTenant(company, async () => {
    const repository = getWarehouseRepository();
    await repository.update("legacy", { location: "Preserved" });
    const exported = await network(`${baseUrl}/${path}.json?format=export`);
    const data = await exported.json();
    assert.equal(data[".priority"], 0);
    assert.equal(data.name[".priority"], 5);
    await repository.archive("legacy");
    assert.equal((await repository.findById("legacy")).isArchived, true);
    assert.deepEqual((await repository.findById("legacy")).custom, {
      preserved: true,
    });
  });
});

test("emulator test rules deny access outside the disposable fixture root", async () => {
  for (const path of [
    "control/private",
    "tenant-fixtures/production/warehouses",
  ]) {
    const response = await network(`${baseUrl}/${path}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    assert.ok([401, 403].includes(response.status));
    await response.arrayBuffer();
  }
});

test("a lost acknowledgement after a real RTDB commit is unknown and cannot create a duplicate", async () => {
  await runWithTenant(tenantId(), async () => {
    const repository = getWarehouseRepository();
    let puts = 0;
    afterResponse = async (_url, options, response) => {
      if (options?.method !== "PUT") return;
      puts++;
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      throw new TypeError("Synthetic connection loss after emulator commit");
    };
    let recordId;
    try {
      await assert.rejects(
        repository.create({ name: "Lost acknowledgement", isActive: true }),
        (error) => {
          assert.equal(error.code, "WAREHOUSE_WRITE_OUTCOME_UNKNOWN");
          assert.equal(error.status, 503);
          assert.ok(error.warehouseId);
          recordId = error.warehouseId;
          return true;
        },
      );
      assert.equal(puts, 1);
    } finally {
      afterResponse = undefined;
    }
    assert.equal((await repository.findById(recordId)).revision, 1);
    await assert.rejects(
      repository.create({ name: " lost ACKNOWLEDGEMENT ", isActive: true }),
      { code: "WAREHOUSE_ALREADY_EXISTS", warehouseId: recordId },
    );
    assert.equal((await repository.list()).length, 1);
  });
});

test("a gzip export restores one synthetic company exactly without changing its source or neighbour", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { gzipSync } = require("node:zlib");
  const {
    digest,
    readBackup,
    analyzeBackup,
    compareBackups,
  } = require("../../scripts/audit-backup.cjs");
  const source = tenantId();
  const destination = tenantId();
  const neighbour = tenantId();
  const fixture = {
    warehouses: {
      legacy: {
        id: "legacy",
        name: { ".value": "Main", ".priority": 4 },
        isActive: true,
        ".priority": 0,
      },
    },
    products: {
      Main: {
        p: { id: "p", quantity: 7, reservedQuantity: 2, warehouse: "Main" },
      },
    },
    sells: { invoice: { id: "invoice", warehouse: "Main", totalPrice: 35 } },
    accounts: { cash: { balance: 35 } },
    journalEntries: { journal: { lines: [{ debit: 35 }, { credit: 35 }] } },
    customModule: { futureField: "synthetic-data-preserved" },
  };
  const putTenant = async (id, value) => {
    const response = await network(`${baseUrl}/tenant-fixtures/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };
  const exportTenant = async (id) => {
    const response = await network(
      `${baseUrl}/tenant-fixtures/${id}.json?format=export`,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  await putTenant(source, fixture);
  await putTenant(neighbour, { privateFixture: "other-company-preserved" });
  const neighbourBefore = digest(await exportTenant(neighbour));
  const before = await exportTenant(source);
  assert.equal(await exportTenant(destination), null);
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "dahersoft-emulator-restore-"),
  );
  const backupPath = path.join(temporary, "synthetic-company.json.gz");
  try {
    fs.writeFileSync(backupPath, gzipSync(JSON.stringify(before)), {
      flag: "wx",
    });
    await putTenant(destination, readBackup(backupPath));
    const restored = await exportTenant(destination);
    assert.equal(digest(restored), digest(before));
    const options = { scope: "tenant", tenantId: "qa-restore" };
    const comparison = compareBackups(
      analyzeBackup(before, options),
      analyzeBackup(restored, options),
    );
    assert.equal(comparison.equal, true);
    await runWithTenant(destination, () =>
      getWarehouseRepository().archive("legacy"),
    );
    assert.equal(digest(await exportTenant(source)), digest(before));
    assert.equal(digest(await exportTenant(neighbour)), neighbourBefore);
    await runWithTenant(destination, async () => {
      const repository = getWarehouseRepository();
      assert.equal((await repository.findById("legacy")).isArchived, true);
      assert.equal(
        (await client.read(`tenant-fixtures/${destination}/products/Main/p`))
          .quantity,
        7,
      );
    });
  } finally {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    fs.rmdirSync(temporary);
  }
});
