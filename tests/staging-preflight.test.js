const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  getStagingTarget,
  probeStagingTarget,
  parseArguments,
} = require("../scripts/staging-preflight.cjs");

const manifest = () => ({
  schemaVersion: 1,
  purpose: "isolated-staging",
  production: {
    projectId: "dahersoft-live",
    databaseUrl: "https://dahersoft-live-default-rtdb.firebaseio.com",
  },
  staging: {
    projectId: "dahersoft-staging",
    databaseUrl:
      "https://dahersoft-staging-default-rtdb.europe-west1.firebasedatabase.app",
  },
  tenantsRoot: "tenants",
  testTenantId: "qa-staging-warehouse",
});
const environment = () => ({
  NODE_ENV: "production",
  JWT_SECRET: "synthetic-staging-jwt-32-bytes-or-more",
  FIREBASE_projectId: "dahersoft-staging",
  FIREBASE_REST_AUTH_MODE: "google",
  FIREBASE_databaseURL: manifest().staging.databaseUrl,
});

test("staging configuration validates a separate project and the actual server destination without exposing secrets", () => {
  const target = getStagingTarget(manifest(), environment());
  assert.equal(target.projectId, "dahersoft-staging");
  assert.equal(target.testTenantId, "qa-staging-warehouse");
  assert.ok(Object.isFrozen(target));
  assert.doesNotMatch(
    JSON.stringify(target),
    /synthetic-staging-jwt|dahersoft-live/,
  );
});

test("staging validation refuses the production project or database and misleading namespace mappings", () => {
  for (const modify of [
    (copy) => {
      copy.staging.projectId = copy.production.projectId;
    },
    (copy) => {
      copy.staging.databaseUrl = copy.production.databaseUrl;
    },
    (copy) => {
      copy.staging.databaseUrl =
        "https://unrelated-default-rtdb.firebaseio.com";
    },
  ]) {
    const copy = manifest();
    modify(copy);
    assert.throws(
      () => getStagingTarget(copy, environment()),
      /STAGING_NOT_ISOLATED|STAGING_DATABASE_PROJECT_MISMATCH/,
    );
  }
});

test("staging validation rejects destination injection, unsafe test scopes and secret fields in the manifest", () => {
  for (const modify of [
    (copy) => {
      copy.staging.databaseUrl = "http://127.0.0.1:19000";
    },
    (copy) => {
      copy.staging.databaseUrl += "/tenants/other";
    },
    (copy) => {
      copy.staging.databaseUrl += "?auth=private-token";
    },
    (copy) => {
      copy.staging.databaseUrl =
        "https://user:private-token@dahersoft-staging.firebaseio.com";
    },
    (copy) => {
      copy.staging.privateKey = "private-key";
    },
    (copy) => {
      copy.testTenantId = "default";
    },
    (copy) => {
      copy.tenantsRoot = "control";
    },
    (copy) => {
      copy.tenantsRoot = "tenants/other";
    },
    (copy) => {
      copy.purpose = "production";
    },
  ]) {
    const copy = manifest();
    modify(copy);
    assert.throws(
      () => getStagingTarget(copy, environment()),
      (error) => {
        assert.match(error.message, /^STAGING_/);
        assert.doesNotMatch(error.message, /private-|https?:/);
        return true;
      },
    );
  }
  assert.throws(
    () =>
      getStagingTarget(
        require("../docs/saas/staging.example.json"),
        environment(),
      ),
    /STAGING_INVALID_MANIFEST/,
  );
});

test("staging preflight requires secure runtime settings and matching SDK/REST project and tenant root", () => {
  for (const overrides of [
    { NODE_ENV: "development" },
    { JWT_SECRET: "short" },
    { FIREBASE_REST_AUTH_MODE: "anonymous" },
    { FIREBASE_projectId: "dahersoft-live" },
    { FIREBASE_databaseURL: manifest().production.databaseUrl },
    { TENANTS_ROOT: "other" },
  ])
    assert.throws(
      () => getStagingTarget(manifest(), { ...environment(), ...overrides }),
      /STAGING_RUNTIME_/,
    );
});

test("the staging probe requests Google credentials and reads only the chosen fixture paths", async () => {
  const requests = [];
  const getAccessToken = async () => "synthetic-token";
  const result = await probeStagingTarget(
    getStagingTarget(manifest(), environment()),
    {
      getAccessToken,
      createClient: (options) => {
        assert.equal(options.baseUrl, manifest().staging.databaseUrl);
        assert.equal(options.getAccessToken, getAccessToken);
        return {
          read: async (path) => {
            requests.push(path);
            return null;
          },
          readVersioned: async (path) => {
            requests.push(path);
            return { value: null, etag: '"fixture"' };
          },
          compareAndSet: () =>
            assert.fail("A staging read probe must never write"),
        };
      },
    },
  );
  assert.deepEqual(requests.sort(), [
    "control/companies/qa-staging-warehouse",
    "tenants/qa-staging-warehouse/warehouses/__staging_probe__",
  ]);
  assert.deepEqual(result, {
    cloudReadChecked: true,
    versionedReadChecked: true,
  });
});

test("staging credential or network failures are redacted and never fall back or write", async () => {
  let reads = 0;
  await assert.rejects(
    probeStagingTarget(getStagingTarget(manifest(), environment()), {
      createClient: () => ({
        read: async () => {
          reads++;
          throw new Error("PRIVATE-KEY-OR-URL");
        },
        readVersioned: async () => {
          reads++;
          throw new Error("PRIVATE-KEY-OR-URL");
        },
      }),
    }),
    { code: "STAGING_READ_PROBE_FAILED" },
  );
  assert.equal(reads, 2);
});

test("staging CLI requires an explicit config and hides malformed input content", () => {
  assert.throws(() => parseArguments([]), /STAGING_INVALID_ARGUMENTS/);
  assert.throws(
    () => parseArguments(["--config", "a", "--config", "b"]),
    /STAGING_INVALID_ARGUMENTS/,
  );
  assert.throws(
    () => parseArguments(["--config", "a", "--probe", "--probe"]),
    /STAGING_INVALID_ARGUMENTS/,
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/staging-preflight.cjs"],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /STAGING_INVALID_ARGUMENTS/);
  assert.equal(result.stdout, "");
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "dahersoft-preflight-"),
  );
  const file = path.join(temporary, "malformed.json");
  try {
    fs.writeFileSync(file, '{"PRIVATE-MALFORMED-CONTENT":', { flag: "wx" });
    const malformed = spawnSync(
      process.execPath,
      ["scripts/staging-preflight.cjs", "--config", file, "--probe"],
      { encoding: "utf8", timeout: 3000 },
    );
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /STAGING_PREFLIGHT_FAILED/);
    assert.doesNotMatch(
      malformed.stdout + malformed.stderr,
      /PRIVATE-MALFORMED-CONTENT/,
    );
    assert.equal(malformed.stdout, "");
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(temporary);
  }
});
