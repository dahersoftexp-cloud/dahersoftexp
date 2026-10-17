const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { scanProject } = require("../scripts/audit-source.cjs");
const root = path.resolve(__dirname, "..");

test("static inventory finds current route mounts and distinguishes root SDK access from tenant wrapper", () => {
  const inventory = scanProject(root);
  assert.ok(
    inventory.routes.some(
      (route) =>
        route.apiPath === "/api/transactions/sell" && route.method === "POST",
    ),
  );
  assert.ok(
    inventory.databaseReferences.some(
      (entry) =>
        entry.file === "src/tenancy/tenantDatabaseProvider.ts" &&
        entry.access === "server-rest",
    ),
  );
  assert.ok(
    inventory.databaseReferences.some(
      (entry) =>
        entry.file === "src/tenancy/controlDatabase.ts" &&
        entry.access === "direct-sdk",
    ),
  );
  assert.ok(
    inventory.databaseReferences.some(
      (entry) =>
        entry.file === "src/controllers/trials.controller.ts" &&
        entry.access === "control-root",
    ),
  );
  assert.ok(
    inventory.databaseReferences.some(
      (entry) =>
        entry.file === "src/controllers/sells.controller.ts" &&
        entry.access === "tenant-wrapper",
    ),
  );
  assert.ok(
    inventory.routes.every(
      (route) => route.authorization === "manual-review-required",
    ),
  );
});

test("backup CLI reads JSON and gzip, compares without rewriting inputs, and redacts malformed input", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "daher-baseline-"));
  const beforePath = path.join(temporary, "before.json");
  const afterPath = path.join(temporary, "after.json.gz");
  const invalidPath = path.join(temporary, "invalid.json");
  const original = JSON.stringify({
    tenants: { a: { customer: { c: { name: "PRIVATE-FIXTURE-ONLY" } } } },
  });
  try {
    fs.writeFileSync(beforePath, original);
    fs.writeFileSync(afterPath, zlib.gzipSync(original));
    fs.writeFileSync(invalidPath, "PRIVATE-FIXTURE-ONLY: invalid-json");
    const run = (args) =>
      spawnSync(process.execPath, ["scripts/audit-backup.cjs", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
      });
    const result = run([
      "--input",
      beforePath,
      "--scope",
      "database",
      "--compare",
      afterPath,
    ]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).comparison.equal, true);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-FIXTURE-ONLY/);
    assert.equal(fs.readFileSync(beforePath, "utf8"), original);
    fs.writeFileSync(
      afterPath,
      zlib.gzipSync(JSON.stringify({ tenants: { a: {} } })),
    );
    assert.equal(
      run([
        "--input",
        beforePath,
        "--scope",
        "database",
        "--compare",
        afterPath,
      ]).status,
      2,
    );
    const invalid = run(["--input", invalidPath, "--scope", "database"]);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(
      invalid.stdout + invalid.stderr,
      /PRIVATE-FIXTURE-ONLY/,
    );
  } finally {
    // Known synthetic files only; do not recursively remove a computed path.
    for (const file of [beforePath, afterPath, invalidPath])
      if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(temporary);
  }
});

test("legacy smoke CLI refuses an external target before making requests", () => {
  const result = spawnSync(process.execPath, ["tests/live-api-smoke.js"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      SMOKE_ALLOW_WRITES: "isolated-test-database",
      API_BASE_URL: "https://dahersoftexp.onrender.com",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /loopback server URL/);
  assert.doesNotMatch(result.stdout, /Smoke test base|PASS|FAIL/);
});
