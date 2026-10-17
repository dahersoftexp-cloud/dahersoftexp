// Local exports only: no Firebase import, credentials, network, or data writes.
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const tenantCollections = ["users", "settings", "accounts", "journalEntries", "products", "sells", "purchases", "customer", "supplier", "payment", "returns", "warehouses", "warehouseTransfers", "quotations", "materialReservations", "invoiceDrafts", "ai", "aiReports", "analytics", "exchange", "doneExchange"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const entries = (value) => object(value) || Array.isArray(value) ? Object.entries(value).filter(([, item]) => item !== null) : [];

function digest(value) {
  const hash = crypto.createHash("sha256");
  function append(item) {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite values are not valid database data.");
    if (Array.isArray(item)) {
      hash.update("[");
      item.forEach((child, index) => { if (index) hash.update(","); append(child); });
      hash.update("]");
    } else if (object(item)) {
      hash.update("{");
      Object.keys(item).sort().forEach((key, index) => {
        if (index) hash.update(",");
        hash.update(JSON.stringify(key)); hash.update(":"); append(item[key]);
      });
      hash.update("}");
    } else hash.update(JSON.stringify(item));
  }
  append(value);
  return hash.digest("hex");
}

function summarizeTenant(value) {
  if (!object(value)) throw new Error("Tenant export must be a JSON object.");
  const collections = {};
  for (const [name, node] of Object.entries(value)) {
    if (!tenantCollections.includes(name)) continue;
    collections[name] = { childCount: entries(node).length, sha256: digest(node) };
  }
  const products = entries(value.products).reduce((count, [, warehouse]) => count + entries(warehouse).length, 0);
  const journals = entries(value.journalEntries);
  return {
    sha256: digest(value), collections,
    unknownCollectionCount: Object.keys(value).filter((key) => !tenantCollections.includes(key)).length,
    productRecordCount: products,
    journalLineCount: journals.reduce((count, [, journal]) => count + entries(journal?.lines).length, 0),
  };
}

function analyzeBackup(value, { scope, tenantId, tenantsRoot = "tenants" }) {
  if (!object(value)) throw new Error("Backup root must be a JSON object.");
  if (!["database", "tenant"].includes(scope)) throw new Error("Explicit --scope database or --scope tenant is required.");
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantsRoot)) throw new Error("Invalid tenants root.");
  const result = { reportVersion: 1, scope, sha256: digest(value), scopes: {}, warnings: [] };
  if (scope === "tenant") {
    if (!tenantId || !/^[a-z0-9_-]+$/.test(tenantId)) throw new Error("--tenant-id is required for a tenant export.");
    if (Object.hasOwn(value, tenantsRoot)) throw new Error("A database export cannot be labeled as a tenant export.");
    result.scopes[`tenant:${tenantId}`] = summarizeTenant(value);
  } else {
    if (value[tenantsRoot] !== undefined && value[tenantsRoot] !== null && !object(value[tenantsRoot])) {
      throw new Error("Invalid tenants container.");
    }
    for (const [id, data] of entries(value[tenantsRoot])) {
      // Preserve the stored key: normalization could conceal migration collisions.
      result.scopes[`tenant:${id}`] = summarizeTenant(data);
    }
    const legacy = Object.fromEntries(Object.entries(value).filter(([name]) => tenantCollections.includes(name)));
    if (Object.keys(legacy).length) {
      result.scopes.legacyRoot = summarizeTenant(legacy);
      result.warnings.push("Legacy tenant collections exist at the database root. Ownership must be established before migration.");
    }
    result.otherRootChildCount = Object.keys(value).filter((key) => key !== tenantsRoot && !tenantCollections.includes(key)).length;
    result.otherRootSha256 = digest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== tenantsRoot && !tenantCollections.includes(key))));
    if (!entries(value[tenantsRoot]).length) result.warnings.push("No tenant nodes found. Confirm the export scope and configured tenants root.");
  }
  result.warnings.push("Structural inventory only: matching hashes do not prove accounting correctness or a consistent live snapshot.");
  return result;
}

function compareBackups(before, after) {
  if (before.scope !== after.scope) throw new Error("Backup scopes differ.");
  const keys = [...new Set([...Object.keys(before.scopes), ...Object.keys(after.scopes)])].sort();
  return { equal: before.sha256 === after.sha256,
    otherRootChanged: before.otherRootSha256 !== after.otherRootSha256,
    scopes: keys.map((key) => ({
    scope: key,
    status: !Object.hasOwn(before.scopes, key) ? "added" : !Object.hasOwn(after.scopes, key) ? "removed"
      : before.scopes[key].sha256 === after.scopes[key].sha256 ? "unchanged" : "changed",
  })) };
}

function readBackup(file) {
  const bytes = fs.readFileSync(file);
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
  return JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
}

function main(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--compare", "--scope", "--tenant-id", "--tenants-root"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error("Invalid arguments.");
    flags.set(args[i], args[i + 1]);
  }
  if (!flags.has("--input")) throw new Error("--input is required.");
  const options = { scope: flags.get("--scope"), tenantId: flags.get("--tenant-id"), tenantsRoot: flags.get("--tenants-root") || "tenants" };
  const report = analyzeBackup(readBackup(flags.get("--input")), options);
  if (flags.has("--compare")) {
    report.comparison = compareBackups(report, analyzeBackup(readBackup(flags.get("--compare")), options));
    if (!report.comparison.equal) process.exitCode = 2;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Backup audit failed. Use --input <local.json or .gz> --scope database|tenant [--tenant-id id] [--compare restored.json]. File contents are never printed."); process.exitCode = 1; }
}
module.exports = { digest, analyzeBackup, compareBackups, readBackup };
