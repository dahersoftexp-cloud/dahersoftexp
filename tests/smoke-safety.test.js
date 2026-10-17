const assert = require("node:assert/strict");
const test = require("node:test");
const { getSmokeTarget, assertIsolatedLogin } = require("../scripts/lib/smoke-safety.cjs");
const approved = { SMOKE_ALLOW_WRITES: "isolated-test-database", API_BASE_URL: "http://127.0.0.1:5001", SMOKE_TENANT_ID: "qa-smoke-fixture" };

test("smoke refuses production URLs, implicit destinations and non-disposable tenants", () => {
  assert.throws(() => getSmokeTarget({}), /Smoke writes require/);
  assert.throws(() => getSmokeTarget({ ...approved, API_BASE_URL: undefined }), /explicitly/);
  for (const url of ["https://dahersoftexp.onrender.com", "http://localhost.evil.test", "http://127.0.0.1@evil.test", "http://localhost/path", "http://localhost?token=value", "file:///tmp/export.json", "http://user:pass@localhost"]) {
    assert.throws(() => getSmokeTarget({ ...approved, API_BASE_URL: url }));
  }
  assert.throws(() => getSmokeTarget({ ...approved, SMOKE_TENANT_ID: "default" }), /qa-smoke-/);
  assert.throws(() => getSmokeTarget({ ...approved, SMOKE_TENANT_ID: "qa-smoke-../default" }));
});

test("smoke accepts an explicit local disposable target", () => {
  assert.equal(getSmokeTarget(approved).baseUrl, "http://127.0.0.1:5001");
  assert.equal(getSmokeTarget({ ...approved, API_BASE_URL: "http://[::1]:5001/" }).baseUrl, "http://[::1]:5001");
});

test("smoke stops when a failed or mismatched login would fall back to another tenant", () => {
  const token = (tenantId) => `header.${Buffer.from(JSON.stringify({ tenantId })).toString("base64url")}.signature`;
  const response = { ok: true, data: { user: { tenantId: "qa-smoke-fixture" }, token: token("qa-smoke-fixture") } };
  assert.doesNotThrow(() => assertIsolatedLogin(response, "qa-smoke-fixture"));
  assert.throws(() => assertIsolatedLogin(null, "qa-smoke-fixture"));
  assert.throws(() => assertIsolatedLogin({ ...response, ok: false }, "qa-smoke-fixture"));
  assert.throws(() => assertIsolatedLogin({ ok: true, data: { ...response.data, token: token("default") } }, "qa-smoke-fixture"));
  assert.throws(() => assertIsolatedLogin({ ok: true, data: { ...response.data, token: "invalid" } }, "qa-smoke-fixture"));
});
