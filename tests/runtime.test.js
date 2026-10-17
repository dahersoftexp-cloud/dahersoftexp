const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  getJwtSecret,
  assertRuntimeConfiguration,
} = require("../dist/config/runtime");

test("production rejects missing and weak JWT secrets without exposing their values", () => {
  for (const secret of [
    undefined,
    "",
    "   ",
    "secret",
    "short-production-secret",
  ]) {
    assert.throws(
      () =>
        assertRuntimeConfiguration({
          NODE_ENV: "production",
          JWT_SECRET: secret,
        }),
      /Production requires JWT_SECRET/,
    );
  }
  assert.equal(
    getJwtSecret({
      NODE_ENV: "production",
      JWT_SECRET: "local-fixture-with-32-or-more-bytes",
    }),
    "local-fixture-with-32-or-more-bytes",
  );
});

test("development preserves the legacy secret so this baseline does not rotate current sessions", () => {
  assert.equal(getJwtSecret({ NODE_ENV: "development" }), "secret");
  assert.equal(
    getJwtSecret({ NODE_ENV: "test", JWT_SECRET: "test-only" }),
    "test-only",
  );
});

test("production boot rejects a weak secret before loading Firebase or starting the server", () => {
  const result = spawnSync(process.execPath, ["dist/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      JWT_SECRET: "short-value-for-test",
      DOTENV_CONFIG_PATH: path.resolve(__dirname, "no-env-file"),
      FIREBASE_databaseURL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production requires JWT_SECRET/);
  assert.doesNotMatch(
    result.stderr,
    /FIREBASE FATAL|FirebaseError|short-value-for-test/,
  );
  assert.doesNotMatch(result.stdout, /Server running/);
});

test("production rejects an anonymous database reader before initializing Firebase", () => {
  const result = spawnSync(process.execPath, ["dist/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      JWT_SECRET: "synthetic-strong-secret-with-at-least-32-bytes",
      DOTENV_CONFIG_PATH: path.resolve(__dirname, "no-env-file"),
      FIREBASE_databaseURL: "https://synthetic-fixture.firebaseio.com",
      FIREBASE_REST_AUTH_MODE: "anonymous",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require Google credentials/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Server running|FIREBASE FATAL|FirebaseError|synthetic-strong-secret/,
  );
});
