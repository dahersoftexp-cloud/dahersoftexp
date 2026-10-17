import { createHash, randomUUID } from "crypto";
import { readServerJson } from "../infrastructure/serverDatabase";
import { rootRef, rootUpdate as update, rootRunTransaction as runTransaction } from "../tenancy/controlDatabase";
import { CurrentUser, UserSource } from "../utils/currentUser";
import {
  getTenantDatabasePath,
  LEGACY_ROOT_TENANT_ID,
  validateTenantId,
} from "../utils/tenantContext";
import { hashPassword } from "./passwords";

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const isUserKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= 256 &&
  !/[.#$\/\[\]\u0000-\u001f\u007f]/.test(value);
export const normalizePermissions = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
            .map((item) => item.trim()),
        ),
      ]
    : [];
export const readObject = async (
  path: string,
): Promise<Record<string, any> | null> => {
  const value = await readServerJson(path);
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new AuthError(503, "AUTH_STORE_INVALID");
  return value;
};
export interface StoredAccount {
  tenantId: string;
  key: string;
  source: UserSource;
  path: string;
  profile: Record<string, any>;
  identity: Record<string, any>;
  membership: Record<string, any>;
  identityId: string;
  central: boolean;
}
export const accountPath = (
  tenantId: string,
  key: string,
  source: UserSource,
) => {
  validateTenantId(tenantId);
  if (!isUserKey(key)) throw new AuthError(400, "INVALID_USER_KEY");
  if (source === "legacy-root") {
    if (tenantId !== LEGACY_ROOT_TENANT_ID)
      throw new AuthError(403, "MEMBERSHIP_REQUIRED");
    return `users/${key}`;
  }
  return getTenantDatabasePath(`users/${key}`, tenantId);
};
export async function findAccount(
  tenantId: string,
  key: string,
  source?: UserSource,
): Promise<StoredAccount | null> {
  if (!isUserKey(key)) return null;
  validateTenantId(tenantId);
  const sources: UserSource[] = source
    ? [source]
    : tenantId === LEGACY_ROOT_TENANT_ID
      ? ["legacy-root", "tenant"]
      : ["tenant"];
  for (const candidate of sources) {
    const path = accountPath(tenantId, key, candidate);
    const profile = await readObject(path);
    if (!profile) continue;
    if (profile.tenantId && profile.tenantId !== tenantId)
      throw new AuthError(403, "MEMBERSHIP_REQUIRED");
    if (profile.identityId !== undefined) {
      if (!isUserKey(profile.identityId))
        throw new AuthError(403, "MEMBERSHIP_REQUIRED");
      const [identity, membership] = await Promise.all([
        readObject(`control/identities/${profile.identityId}`),
        readObject(`control/memberships/${tenantId}/${profile.identityId}`),
      ]);
      if (!identity || !membership || membership.userId !== key)
        throw new AuthError(403, "MEMBERSHIP_REQUIRED");
      return {
        tenantId,
        key,
        source: candidate,
        path,
        profile,
        identity,
        membership,
        identityId: profile.identityId,
        central: true,
      };
    }
    const identityId = `legacy-${createHash("sha256")
      .update(
        JSON.stringify([candidate, tenantId, key, profile.createdAt || ""]),
      )
      .digest("hex")}`;
    return {
      tenantId,
      key,
      source: candidate,
      path,
      profile,
      identity: profile,
      membership: profile,
      identityId,
      central: false,
    };
  }
  return null;
}
export function principalFor(account: StoredAccount): CurrentUser {
  const { profile, identity, membership } = account;
  if (
    account.central &&
    (identity.status !== "active" || membership.status !== "active")
  )
    throw new AuthError(403, "MEMBERSHIP_INACTIVE");
  for (const record of [profile, identity, membership]) {
    if (
      record.isActive === false ||
      (record.status !== undefined && record.status !== "active")
    )
      throw new AuthError(403, "MEMBERSHIP_INACTIVE");
  }
  return {
    userId: account.key,
    username:
      typeof profile.username === "string" ? profile.username : account.key,
    tenantId: account.tenantId,
    identityId: account.identityId,
    source: account.source,
    role: typeof membership.role === "string" ? membership.role : "user",
    permissions: normalizePermissions(
      membership.permissions ??
        membership.allowedPages ??
        membership.pagePermissions ??
        (!account.central
          ? membership.role === "driver"
            ? ["driver-sales"]
            : membership.role === "user" || membership.role === undefined
              ? ["home", "dashboard", "products"]
              : []
          : []),
    ),
    platformPermissions: account.central
      ? normalizePermissions(identity.platformPermissions)
      : [],
    sessionVersion:
      typeof identity.sessionVersion === "string"
        ? identity.sessionVersion
        : "legacy",
    vehicleId: profile.vehicleId || "",
    vehicleName: profile.vehicleName || "",
  };
}
export async function listAccounts(tenantId: string): Promise<StoredAccount[]> {
  const scoped =
    (await readObject(getTenantDatabasePath("users", tenantId))) || {};
  const root =
    tenantId === LEGACY_ROOT_TENANT_ID ? (await readObject("users")) || {} : {};
  const result: StoredAccount[] = [];
  for (const key of [
    ...new Set([...Object.keys(scoped), ...Object.keys(root)]),
  ]) {
    try {
      const account = await findAccount(tenantId, key);
      if (account) result.push(account);
    } catch (error) {
      if (!(error instanceof AuthError) || error.status >= 500) throw error;
    }
  }
  return result;
}
export async function prepareManagedAccount(
  tenantId: string,
  username: string,
  password: string,
  profileData: Record<string, any> = {},
) {
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const role = profileData.role || "user";
  const permissions = normalizePermissions(profileData.permissions);
  const profile = {
    ...profileData,
    username,
    identityId,
    tenantId,
    role,
    permissions,
    createdAt: now,
    updatedAt: now,
  };
  const identity = {
    passwordHash: await hashPassword(password),
    status: "active",
    managedByTenantId: tenantId,
    sessionVersion: randomUUID(),
    createdAt: now,
  };
  const membership = {
    userId: username,
    role,
    permissions,
    status: "active",
    createdAt: now,
  };
  return {
    profile,
    updates: {
      [`control/identities/${identityId}`]: identity,
      [`control/memberships/${tenantId}/${identityId}`]: membership,
    } as Record<string, any>,
  };
}
export const writeAccountUpdates = (updates: Record<string, any>) =>
  update(rootRef(), updates);

export const reserveManagedProfile = (
  tenantId: string,
  username: string,
  identityId: string,
) => {
  if (!isUserKey(username) || !isUserKey(identityId))
    throw new AuthError(400, "INVALID_USER_KEY");
  return runTransaction(
    rootRef(getTenantDatabasePath(`users/${username}`, tenantId)),
    (current) =>
      current === null
        ? { username, identityId, status: "provisioning" }
        : undefined,
  );
};
