import { AsyncLocalStorage } from "async_hooks";
import { getCurrentUserFromRequest } from "./currentUser";
import type { Request } from "express";

export interface TenantContext {
  tenantId: string;
}
const tenantStorage = new AsyncLocalStorage<TenantContext>();
export function validateTenantId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value))
    throw new Error("INVALID_TENANT_ID");
  return value;
}
// Slug generation is for provisioning only; authentication uses strict validation.
export function sanitizeTenantId(value: string) {
  return validateTenantId(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
}
export const TENANTS_ROOT = validateTenantId(
  process.env.TENANTS_ROOT || "tenants",
);
if (["control", "users"].includes(TENANTS_ROOT))
  throw new Error("TENANTS_ROOT must not overlap identity or control data.");
export const DEFAULT_TENANT_ID = validateTenantId(
  process.env.DEFAULT_TENANT_ID || "default",
);
export const LEGACY_ROOT_TENANT_ID = validateTenantId(
  process.env.LEGACY_ROOT_TENANT_ID || DEFAULT_TENANT_ID,
);
export const normalizeDatabasePath = (path = "") =>
  path.replace(/^\/+|\/+$/g, "");
export const getActiveTenantId = () => {
  const tenantId = tenantStorage.getStore()?.tenantId;
  if (!tenantId) throw new Error("TENANT_CONTEXT_REQUIRED");
  return tenantId;
};
export const getTenantDatabasePath = (
  path = "",
  tenantId = getActiveTenantId(),
) => {
  const tenantRoot = `${TENANTS_ROOT}/${validateTenantId(tenantId)}`;
  const cleanPath = normalizeDatabasePath(path);
  if (!cleanPath) return tenantRoot;
  if (cleanPath === tenantRoot || cleanPath.startsWith(`${tenantRoot}/`))
    return cleanPath;
  if (cleanPath === TENANTS_ROOT || cleanPath.startsWith(`${TENANTS_ROOT}/`))
    throw new Error("CROSS_TENANT_PATH");
  return `${tenantRoot}/${cleanPath}`;
};
export function runWithTenant<T>(tenantId: string, callback: () => T) {
  return tenantStorage.run({ tenantId: validateTenantId(tenantId) }, callback);
}
export const getTenantIdFromRequest = (req: Request) => {
  const user = getCurrentUserFromRequest(req);
  if (!user) throw new Error("TENANT_CONTEXT_REQUIRED");
  return user.tenantId;
};
