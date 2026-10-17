import * as sdk from "firebase/database";
import type { Database, DatabaseReference, DataSnapshot } from "firebase/database";
import { randomUUID } from "crypto";
import { database } from "../firebaseConfig";
import { getTenantDatabasePath } from "./tenantContext";
import { currentFinancialUnit, readFinancialSnapshot, writeFinancialSnapshot, isFinancialCollection } from "../tenancy/financialUnit";
import { getTenantDatabase } from "../tenancy/tenantDatabaseProvider";

export { database };

export const getDatabase = () => database;

export const ref = (
  databaseOrPath?: Database | string | null,
  path?: string,
): DatabaseReference => {
  const requestedPath =
    typeof databaseOrPath === "string"
      ? databaseOrPath
      : typeof path === "string"
        ? path
        : "";

  const full = getTenantDatabasePath(requestedPath);
  const target = sdk.ref(database, full);
  paths.set(target, full);
  return target;
};

const paths = new WeakMap<object, string>();
const pathOf = (target: DatabaseReference) => {
  const path = paths.get(target);
  if (!path) throw new Error("UNSCOPED_DATABASE_REFERENCE");
  const root = getTenantDatabasePath();
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error("CROSS_TENANT_PATH");
  return path;
};
const snapshot = (value: any, key: string | null): DataSnapshot => ({
  key,
  exists: () => value !== undefined && value !== null,
  val: () => value === undefined ? null : structuredClone(value),
  forEach: (callback: (child: DataSnapshot) => boolean | void) => {
    for (const [childKey, child] of Object.entries(value || {}))
      if (child !== null && callback(snapshot(child, childKey)) === true) return true;
    return false;
  },
}) as DataSnapshot;
const relativePath = (target: DatabaseReference) => pathOf(target).slice(getTenantDatabasePath().length + 1);
const assertWriteBoundary = (target: DatabaseReference, children?: string[]) => {
  const relative = relativePath(target);
  if ((!relative || isFinancialCollection(relative) || children?.some(key => isFinancialCollection(`${relative}/${key}`.replace(/^\//, "")))) && !currentFinancialUnit())
    throw new Error("FINANCIAL_UNIT_REQUIRED");
};
export const get: typeof sdk.get = async target => {
  const reference = target as DatabaseReference;
  if (currentFinancialUnit()) return snapshot(readFinancialSnapshot(pathOf(reference)), reference.key);
  const relative = relativePath(reference);
  // Keep the legacy identity adapter isolated; all business reads use fresh server REST.
  if (relative.split("/")[0] === "users") return sdk.get(target);
  return snapshot(await getTenantDatabase().read(relative), reference.key);
};
export const set: typeof sdk.set = async (target, value) => {
  if (currentFinancialUnit()) writeFinancialSnapshot(pathOf(target), value);
  else { assertWriteBoundary(target); await sdk.set(target, value); }
};
export const remove: typeof sdk.remove = async target => set(target, null);
export const update: typeof sdk.update = async (target, values) => {
  if (!currentFinancialUnit()) { assertWriteBoundary(target, Object.keys(values)); await sdk.update(target, values); return; }
  for (const [key, value] of Object.entries(values)) writeFinancialSnapshot(`${pathOf(target)}/${key}`, value);
};
export const runTransaction: typeof sdk.runTransaction = async (target, updater, options) => {
  if (!currentFinancialUnit()) { assertWriteBoundary(target); return sdk.runTransaction(target, updater, options); }
  const next = updater(readFinancialSnapshot(pathOf(target)));
  if (next === undefined) return { committed: false, snapshot: snapshot(readFinancialSnapshot(pathOf(target)), target.key), toJSON: () => ({ committed: false }) };
  writeFinancialSnapshot(pathOf(target), next);
  return { committed: true, snapshot: snapshot(next, target.key), toJSON: () => ({ committed: true }) };
};
export const push: typeof sdk.push = (target, value?) => {
  if (!currentFinancialUnit()) {
    if (value !== undefined) assertWriteBoundary(target);
    const child = sdk.push(target, value);
    paths.set(child, `${pathOf(target)}/${child.key}`);
    return child;
  }
  const child = ref(database, `${pathOf(target)}/${randomUUID()}`);
  if (value !== undefined) writeFinancialSnapshot(pathOf(child), value);
  const resolved = sdk.ref(database, pathOf(child));
  paths.set(resolved, pathOf(child));
  return Object.assign(child, {
    then: (resolve: any, reject: any) => Promise.resolve(resolved).then(resolve, reject),
    catch: (reject: any) => Promise.resolve(resolved).catch(reject),
  }) as ReturnType<typeof sdk.push>;
};
