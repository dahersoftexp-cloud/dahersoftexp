const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  getEmulatorInvocation,
} = require("../scripts/run-warehouse-emulator.cjs");
const configuration = require("../firebase.emulator.json");

test("emulator entry refuses an implicit or external destination before any writes", () => {
  for (const host of [
    "",
    "production.invalid:9000",
    "https://127.0.0.1:9000",
    "127.0.0.1:9000/path",
  ]) {
    const result = spawnSync(
      process.execPath,
      ["tests/emulator/warehouse.test.js"],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        timeout: 3000,
        env: { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: host },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /explicit loopback/);
  }
});

test("emulator entry refuses a real project even when the host is local", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/emulator/warehouse.test.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 3000,
      env: {
        ...process.env,
        FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:19000",
        GCLOUD_PROJECT: "real-project-must-not-be-used",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require the demo project/);
});

test("emulator launcher fixes the demo destination and excludes server secrets and agent debug flags", () => {
  const invocation = getEmulatorInvocation(
    {
      PATH: "system-path",
      SystemRoot: "system-root",
      NODE_ENV: "production",
      FIREBASE_databaseURL: "https://live.invalid",
      FIREBASE_CONFIG: "private-config",
      GOOGLE_APPLICATION_CREDENTIALS: "private-key-file",
      GOOGLE_CLOUD_PROJECT: "live-project",
      GCLOUD_PROJECT: "live-project",
      JWT_SECRET: "private-jwt",
      FIREBASE_TOKEN: "private-token",
      FIREBASE_DATABASE_EMULATOR_HOST: "external.invalid:19000",
      DEBUG: "*",
      CODEX_CI: "1",
    },
    configuration,
  );
  assert.equal(invocation.environment.NODE_ENV, "test");
  assert.equal(invocation.environment.PATH, "system-path");
  assert.equal(invocation.environment.SystemRoot, "system-root");
  assert.equal(
    invocation.args[invocation.args.indexOf("--project") + 1],
    "demo-dahersoft-warehouse",
  );
  assert.doesNotMatch(
    JSON.stringify(invocation),
    /private-|live-project|external\.invalid|DEBUG|CODEX_CI/,
  );
});

test("emulator launcher rejects network binding and rule-file overrides before spawning tooling", () => {
  for (const change of [
    (copy) => {
      copy.emulators.database.host = "0.0.0.0";
    },
    (copy) => {
      copy.emulators.database.port = 9000;
    },
    (copy) => {
      copy.database.rules = "production.rules.json";
    },
    (copy) => {
      copy.emulators.hub = { host: "0.0.0.0" };
    },
    (copy) => {
      copy.emulators.ui.enabled = true;
    },
  ]) {
    const copy = structuredClone(configuration);
    change(copy);
    assert.throws(
      () => getEmulatorInvocation({}, copy),
      /INVALID_WAREHOUSE_EMULATOR_CONFIGURATION/,
    );
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/run-warehouse-emulator.cjs", "--project", "real-project"],
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 3000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refused invalid configuration/);
});

test("emulator launcher accepts explicit portable Java and an offline tooling cache", () => {
  const invocation = getEmulatorInvocation(
    {
      PATH: "inherited-path",
      JAVA_HOME: "old-java",
      DAHERSOFT_TEST_JAVA_HOME: path.resolve("portable-java"),
      DAHERSOFT_TEST_EMULATOR_CACHE: "emulator-cache",
      DAHERSOFT_EMULATOR_OFFLINE: "1",
    },
    configuration,
  );
  assert.equal(invocation.environment.JAVA_HOME, path.resolve("portable-java"));
  assert.ok(
    invocation.environment.PATH.startsWith(
      path.join(path.resolve("portable-java"), "bin") + path.delimiter,
    ),
  );
  assert.equal(
    invocation.environment.FIREBASE_EMULATORS_PATH,
    "emulator-cache",
  );
  assert.ok(invocation.args.includes("--offline"));
});
