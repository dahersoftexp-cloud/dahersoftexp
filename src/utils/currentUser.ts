import { Request } from "express";
import { JwtPayload } from "jsonwebtoken";
import { verifyToken } from "./jwt";

export type UserSource = "legacy-root" | "tenant";
export interface CurrentUser {
  userId: string; // Company-local key, preserved for drafts and driver references.
  username: string;
  tenantId: string;
  identityId: string;
  source: UserSource;
  role: string;
  permissions: string[];
  sessionVersion: string;
  platformPermissions?: string[];
  vehicleId?: string;
  vehicleName?: string;
}
export interface TokenIdentity {
  userId: string;
  username: string;
  tenantId?: string;
  identityId?: string;
  source?: UserSource;
  sessionVersion?: string;
  expiresAt: number;
}
const requestUsers = new WeakMap<Request, CurrentUser>();
const stringValue = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
export const sanitizeFirebaseKey = (key: string) =>
  key.replace(/[.#$\/\[\]]/g, "_");

/** Decoding identifies a candidate only. Membership still needs a database check. */
export const getUserFromToken = (token?: string): TokenIdentity | null => {
  if (!token) return null;
  try {
    const payload = verifyToken(token) as JwtPayload;
    if (
      !payload ||
      typeof payload !== "object" ||
      !Number.isFinite(payload.exp)
    )
      return null;
    const userId = stringValue(payload.userId || payload.username);
    if (!userId) return null;
    const source = payload.source;
    if (source !== undefined && source !== "legacy-root" && source !== "tenant")
      return null;
    return {
      userId,
      username: stringValue(payload.username) || userId,
      tenantId: stringValue(payload.tenantId) || undefined,
      identityId: stringValue(payload.identityId) || undefined,
      source,
      sessionVersion: stringValue(payload.sessionVersion) || undefined,
      expiresAt: Number(payload.exp) * 1000,
    };
  } catch {
    return null;
  }
};
export const getRequestToken = (req: Request) => {
  const authorization = req.headers.authorization;
  return typeof authorization === "string" &&
    authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
};
export const setCurrentUserOnRequest = (req: Request, user: CurrentUser) =>
  requestUsers.set(req, user);
export const getCurrentUserFromRequest = (req: Request): CurrentUser | null =>
  requestUsers.get(req) || null;
export const requireCurrentUser = (req: Request): CurrentUser => {
  const user = getCurrentUserFromRequest(req);
  if (!user) throw new Error("USER_REQUIRED");
  return user;
};
