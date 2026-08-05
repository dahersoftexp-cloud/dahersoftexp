import { AsyncLocalStorage } from "async_hooks";
import { NextFunction, Request, Response } from "express";
import { getUserFromToken } from "./currentUser";

export interface TenantContext {
  tenantId: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export const TENANTS_ROOT = process.env.TENANTS_ROOT || "tenants";
export const DEFAULT_TENANT_ID = sanitizeTenantId(
  process.env.DEFAULT_TENANT_ID || "default",
);

const getStringValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0].trim() : "";
  }

  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const getDecodedStringValue = (value: unknown) => {
  const rawValue = getStringValue(value);
  if (!rawValue) return "";

  try {
    return decodeURIComponent(rawValue).trim();
  } catch {
    return rawValue;
  }
};

export function sanitizeTenantId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "default";
}

export const normalizeDatabasePath = (path = "") =>
  path.replace(/^\/+|\/+$/g, "");

export const getActiveTenantId = () =>
  tenantStorage.getStore()?.tenantId || DEFAULT_TENANT_ID;

export const getTenantDatabasePath = (
  path = "",
  tenantId = getActiveTenantId(),
) => {
  const safeTenantId = sanitizeTenantId(tenantId);
  const cleanPath = normalizeDatabasePath(path);
  const tenantRootPath = `${TENANTS_ROOT}/${safeTenantId}`;

  if (!cleanPath) return tenantRootPath;
  if (cleanPath === tenantRootPath || cleanPath.startsWith(`${tenantRootPath}/`)) {
    return cleanPath;
  }

  return `${tenantRootPath}/${cleanPath}`;
};

export function runWithTenant<T>(tenantId: string | undefined, callback: () => T) {
  return tenantStorage.run(
    { tenantId: sanitizeTenantId(tenantId || DEFAULT_TENANT_ID) },
    callback,
  );
}

const getRequestToken = (req: Request) => {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
};

export const getTenantIdFromRequest = (req: Request) => {
  const tokenTenantId = getUserFromToken(getRequestToken(req))?.tenantId;
  if (tokenTenantId) return sanitizeTenantId(tokenTenantId);

  const headerTenantId = getDecodedStringValue(
    req.headers["x-inventory-tenant-id"] ||
      req.headers["x-tenant-id"] ||
      req.headers["x-company-code"],
  );
  if (headerTenantId) return sanitizeTenantId(headerTenantId);

  const body = req.body || {};
  const bodyTenantId = getStringValue(
    body.tenantId || body.trialId || body.companyCode,
  );
  if (bodyTenantId) return sanitizeTenantId(bodyTenantId);

  const queryTenantId = getStringValue(
    req.query.tenantId || req.query.trialId || req.query.companyCode,
  );
  if (queryTenantId) return sanitizeTenantId(queryTenantId);

  return DEFAULT_TENANT_ID;
};

export const bindTenantContext = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  runWithTenant(getTenantIdFromRequest(req), next);
};
