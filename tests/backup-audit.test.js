const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeBackup, compareBackups, digest } = require("../scripts/audit-backup.cjs");

const fixture = () => ({ users: { synthetic: { password: "synthetic-secret-for-redaction-test" } }, trialTenants: { a: { status: "active" } }, tenants: {
  a: { products: { main: { p: { quantity: 10 } } }, journalEntries: { j: { lines: [{ debit: 10 }, { credit: 10 }] } }, customModule: { hidden: "custom-value-for-redaction-test" } },
  b: { sells: { invoice: { amount: 42 } } },
} });

test("backup inventory covers legacy root, tenants, nested products, journals and unknown modules without printing records", () => {
  const report = analyzeBackup(fixture(), { scope: "database" });
  assert.equal(report.scopes.legacyRoot.collections.users.childCount, 1);
  assert.equal(report.scopes["tenant:a"].productRecordCount, 1);
  assert.equal(report.scopes["tenant:a"].journalLineCount, 2);
  assert.equal(report.scopes["tenant:a"].unknownCollectionCount, 1);
  assert.equal(report.otherRootChildCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-secret-for-redaction-test|custom-value-for-redaction-test|quantity|amount/);
});

test("canonical hashes ignore object property ordering but preserve values, arrays and unknown data", () => {
  assert.equal(digest({ a: 1, b: { y: 2, x: 3 } }), digest({ b: { x: 3, y: 2 }, a: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.throws(() => digest(JSON.parse("1e400")));
  const before = fixture(); const after = fixture();
  after.tenants.a.customModule.hidden = "changed";
  const comparison = compareBackups(analyzeBackup(before, { scope: "database" }), analyzeBackup(after, { scope: "database" }));
  assert.equal(comparison.equal, false);
  assert.equal(comparison.scopes.find((entry) => entry.scope === "tenant:a").status, "changed");
  assert.equal(comparison.scopes.find((entry) => entry.scope === "tenant:b").status, "unchanged");
  const changedControl = fixture();
  changedControl.trialTenants.a.status = "disabled";
  assert.equal(compareBackups(analyzeBackup(before, { scope: "database" }), analyzeBackup(changedControl, { scope: "database" })).otherRootChanged, true);
});

test("backup comparison detects an unchanged copy and a missing tenant", () => {
  const source = fixture(); const restored = JSON.parse(JSON.stringify(source));
  const before = analyzeBackup(source, { scope: "database" });
  assert.equal(compareBackups(before, analyzeBackup(restored, { scope: "database" })).equal, true);
  delete restored.tenants.b;
  assert.equal(compareBackups(before, analyzeBackup(restored, { scope: "database" })).scopes.find((entry) => entry.scope === "tenant:b").status, "removed");
});

test("export scope must be explicit and cannot conceal malformed or full-database exports", () => {
  assert.throws(() => analyzeBackup(fixture(), {}));
  assert.throws(() => analyzeBackup([], { scope: "database" }));
  assert.throws(() => analyzeBackup({ tenants: { a: "invalid" } }, { scope: "database" }));
  assert.throws(() => analyzeBackup(fixture(), { scope: "tenant", tenantId: "a" }));
  assert.throws(() => analyzeBackup({}, { scope: "tenant" }));
  const report = analyzeBackup(fixture().tenants.a, { scope: "tenant", tenantId: "a" });
  assert.equal(report.scopes["tenant:a"].productRecordCount, 1);
});
