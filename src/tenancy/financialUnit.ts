import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import {
  readServerVersioned,
  compareAndSetServerJson,
} from "../infrastructure/serverDatabase";
import {
  getActiveTenantId,
  getTenantDatabasePath,
} from "../utils/tenantContext";
import { validateRelativeDatabasePath } from "./databasePath";
import { assertFinancialIntegrity } from "./financialIntegrity";

type Tree = Record<string, any>;
interface Unit {
  tenantId: string;
  value: Tree;
  actorId: string;
}
const storage = new AsyncLocalStorage<Unit>();
const writable = new Set([
  "accounts",
  "journalEntries",
  "products",
  "sells",
  "purchases",
  "customer",
  "supplier",
  "suppliers",
  "payment",
  "payments",
  "returns",
  "warehouseTransfers",
  "materialReservations",
  "quotations",
  "exchange",
  "doneExchange",
  "invoiceDrafts",
]);
export class FinancialError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export const currentFinancialUnit = () => {
  const unit = storage.getStore();
  if (unit && unit.tenantId !== getActiveTenantId())
    throw new FinancialError("TENANT_CONTEXT_MISMATCH");
  return unit;
};
export const financialActor = () => currentFinancialUnit()?.actorId || "";
export const isFinancialCollection = (path: string) =>
  writable.has(path.split("/")[0]) &&
  !["invoiceDrafts", "quotations"].includes(path.split("/")[0]);
const clean = (value: any): any => {
  if (value === undefined)
    throw new FinancialError("UNDEFINED_DATABASE_VALUE", 400);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new FinancialError("INVALID_FINANCIAL_NUMBER", 400);
    return value;
  }
  if (Array.isArray(value)) return value.map(clean);
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new FinancialError("INVALID_DATABASE_VALUE", 400);
  const result: Tree = {};
  for (const [key, item] of Object.entries(value)) {
    validateRelativeDatabasePath(key);
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new FinancialError("INVALID_DATABASE_KEY", 400);
    if (item !== undefined) result[key] = clean(item);
  }
  return result;
};
const relative = (path: string) => {
  const root = getTenantDatabasePath();
  if (path === root) return "";
  if (!path.startsWith(`${root}/`))
    throw new FinancialError("CROSS_TENANT_PATH");
  const result = path.slice(root.length + 1);
  validateRelativeDatabasePath(result);
  if (
    result
      .split("/")
      .some((key) => ["__proto__", "constructor", "prototype"].includes(key))
  )
    throw new FinancialError("INVALID_DATABASE_KEY", 400);
  return result;
};
export const readFinancialSnapshot = (path: string): any => {
  const unit = currentFinancialUnit();
  if (!unit) throw new FinancialError("FINANCIAL_UNIT_REQUIRED");
  let result: any = unit.value;
  for (const key of relative(path).split("/").filter(Boolean))
    result = result?.[key];
  return result === undefined ? null : structuredClone(result);
};
export const writeFinancialSnapshot = (path: string, value: unknown) => {
  const unit = currentFinancialUnit();
  if (!unit) throw new FinancialError("FINANCIAL_UNIT_REQUIRED");
  const keys = relative(path).split("/");
  if (!keys[0] || !writable.has(keys[0]))
    throw new FinancialError("FINANCIAL_WRITE_PATH_FORBIDDEN");
  const safeValue = clean(value);
  let parent = unit.value;
  for (const key of keys.slice(0, -1)) {
    if (parent[key] === undefined || parent[key] === null) parent[key] = {};
    if (typeof parent[key] !== "object")
      throw new FinancialError("INVALID_DATABASE_PATH", 400);
    parent = parent[key];
  }
  if (safeValue === null) delete parent[keys[keys.length - 1]];
  else parent[keys[keys.length - 1]] = safeValue;
};
const canonical = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export interface FinancialCommand {
  key: string;
  kind: string;
  actorId: string;
  body: unknown;
}
/** Transitional correctness boundary: one ETag protected company snapshot, no external side effects. */
export const runFinancialCommand = async <T>(
  command: FinancialCommand,
  execute: () => Promise<T>,
): Promise<T> => {
  if (currentFinancialUnit())
    throw new FinancialError("NESTED_FINANCIAL_COMMAND");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(command.key))
    throw new FinancialError("IDEMPOTENCY_KEY_REQUIRED", 400);
  const tenantId = getActiveTenantId();
  const root = getTenantDatabasePath();
  const operationId = createHash("sha256").update(command.key).digest("hex");
  const fingerprint = createHash("sha256")
    .update(
      canonical({
        kind: command.kind,
        actorId: command.actorId,
        body: command.body,
      }),
    )
    .digest("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    const revision = await readServerVersioned(root);
    if (getActiveTenantId() !== tenantId)
      throw new FinancialError("TENANT_CONTEXT_MISMATCH");
    const value = structuredClone(revision.value || {}) as Tree;
    const previous = value._financialOperations?.[operationId];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new FinancialError("IDEMPOTENCY_KEY_REUSED");
      return structuredClone(previous.result) as T;
    }
    const result = await storage.run(
      { tenantId, value, actorId: command.actorId },
      execute,
    );
    assertFinancialIntegrity((revision.value || {}) as Tree, value);
    const safeResult = clean(result);
    value._financialOperations ||= {};
    value._financialOperations[operationId] = {
      fingerprint,
      actorId: command.actorId,
      kind: command.kind,
      committedAt: new Date().toISOString(),
      result: safeResult,
    };
    // Retry only a definitive 412. A lost acknowledgement requires replaying the SAME key.
    if (await compareAndSetServerJson(root, revision, value))
      return safeResult as T;
  }
  throw new FinancialError("FINANCIAL_WRITE_CONFLICT");
};
