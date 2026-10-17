import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { InventoryUser, InventoryUserResponse } from "../types/user";
import { getCurrentUserFromRequest } from "../utils/currentUser";
import {
  getActiveTenantId,
  getTenantDatabasePath,
} from "../utils/tenantContext";
import {
  AuthError,
  findAccount,
  isUserKey,
  listAccounts,
  prepareManagedAccount,
  principalFor,
  reserveManagedProfile,
  readObject,
  writeAccountUpdates,
} from "../auth/accounts";
import { hashPassword, isValidPasswordInput } from "../auth/passwords";

const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]]/;
const ARABIC_USERNAME_CHAR_PATTERN =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const getTimestamp = () => new Date().toISOString();

const normalizePermissions = (permissions: unknown): string[] => {
  if (!Array.isArray(permissions)) return [];

  return permissions
    .filter(
      (permission): permission is string => typeof permission === "string",
    )
    .map((permission) => permission.trim())
    .filter(Boolean);
};

const normalizeRole = (role: unknown) =>
  typeof role === "string" && role.trim() ? role.trim() : "user";

const toUserResponse = (
  key: string,
  user: InventoryUser,
): InventoryUserResponse => ({
  id: key,
  username: user.username || key,
  role: normalizeRole(user.role),
  permissions: normalizePermissions(user.permissions),
  vehicleId: user.vehicleId,
  vehicleName: user.vehicleName,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  status: user.status,
});

const isInvalidUsername = (username: string) =>
  !isUserKey(username) ||
  !username.trim() ||
  INVALID_FIREBASE_KEY_CHARS.test(username);

const hasArabicUsernameChars = (username: string) =>
  ARABIC_USERNAME_CHAR_PATTERN.test(username);

const requireAdmin = (req: Request, res: Response) => {
  const currentUser = getCurrentUserFromRequest(req);

  if (!currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  if (currentUser.role !== "admin") {
    res.status(403).json({ error: "Admin permission is required" });
    return null;
  }

  return currentUser;
};

const getUserEntries = async () => {
  const accounts = await listAccounts(getActiveTenantId());
  return accounts.map((account) => {
    let status = "active";
    try {
      principalFor(account);
    } catch {
      status = "revoked";
    }
    return [
      account.key,
      {
        ...account.profile,
        role: account.membership.role,
        permissions: account.membership.permissions,
        status,
      },
    ] as [string, InventoryUser];
  });
};

const countAdmins = (users: Array<[string, InventoryUser]>) =>
  users.filter(
    ([, user]) =>
      normalizeRole(user.role) === "admin" &&
      (!user.status || user.status === "active"),
  ).length;

export const getAllUsers = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const users = (await getUserEntries()).map(([key, user]) =>
      toUserResponse(key, user),
    );

    res.json(users);
  } catch (error: any) {
    res.status(error instanceof AuthError ? error.status : 503).json({
      error: error instanceof AuthError ? error.code : "USER_LIST_UNAVAILABLE",
    });
  }
};

export const createUser = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const username =
    typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password =
    typeof req.body.password === "string" ? req.body.password : "";
  const role = normalizeRole(req.body.role);
  const permissions =
    role === "admin" ? [] : normalizePermissions(req.body.permissions);
  const vehicleId =
    typeof req.body.vehicleId === "string" ? req.body.vehicleId.trim() : "";
  const vehicleName =
    typeof req.body.vehicleName === "string" ? req.body.vehicleName.trim() : "";

  if (isInvalidUsername(username)) {
    return res.status(400).json({
      error:
        "Username is required and cannot contain Firebase key characters: . # $ / [ ]",
    });
  }

  if (hasArabicUsernameChars(username)) {
    return res
      .status(400)
      .json({ error: "Username cannot contain Arabic characters" });
  }

  if (!password.trim() || !isValidPasswordInput(password)) {
    return res.status(400).json({ error: "Password is required" });
  }

  try {
    const tenantId = getActiveTenantId();
    if (await findAccount(tenantId, username)) {
      return res.status(400).json({ error: "User already exists" });
    }

    const prepared = await prepareManagedAccount(tenantId, username, password, {
      role,
      permissions,
      ...(vehicleId ? { vehicleId } : {}),
      ...(vehicleName ? { vehicleName } : {}),
    });
    const path = getTenantDatabasePath(`users/${username}`);
    const reservation = await reserveManagedProfile(
      tenantId,
      username,
      prepared.profile.identityId,
    );
    if (!reservation.committed)
      return res.status(409).json({ error: "User already exists" });
    await writeAccountUpdates({
      ...prepared.updates,
      [path]: prepared.profile,
    });

    res.json({
      message: "User created successfully",
      data: toUserResponse(username, prepared.profile as InventoryUser),
    });
  } catch (error: any) {
    res.status(error instanceof AuthError ? error.status : 503).json({
      error:
        error instanceof AuthError ? error.code : "USER_CREATE_UNAVAILABLE",
    });
  }
};

export const updateUser = async (req: Request, res: Response) => {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) return;

  const { id } = req.params;

  if (isInvalidUsername(id)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  try {
    const account = await findAccount(getActiveTenantId(), id);
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingUser = {
      ...account.profile,
      role: account.membership.role,
      permissions: account.membership.permissions,
    } as InventoryUser;
    if (
      account.source === "legacy-root" &&
      id === (process.env.TRIAL_MANAGER_USERNAME || "and") &&
      currentUser.userId !== id &&
      !currentUser.platformPermissions?.includes("tenants.manage")
    )
      return res.status(403).json({ error: "PLATFORM_IDENTITY_PROTECTED" });
    const nextRole =
      req.body.role === undefined
        ? existingUser.role
        : normalizeRole(req.body.role);
    const nextStatus =
      req.body.status === undefined
        ? account.membership.status || "active"
        : req.body.status;
    if (!["active", "revoked"].includes(nextStatus))
      return res.status(400).json({ error: "INVALID_MEMBERSHIP_STATUS" });

    if (
      (currentUser.username === id || currentUser.userId === id) &&
      (nextRole !== "admin" || nextStatus !== "active")
    ) {
      return res
        .status(400)
        .json({ error: "You cannot remove admin role from your own user" });
    }

    if (
      normalizeRole(existingUser.role) === "admin" &&
      (nextRole !== "admin" || nextStatus !== "active")
    ) {
      const adminCount = countAdmins(await getUserEntries());

      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ error: "At least one admin user is required" });
      }
    }

    const updates: Partial<InventoryUser> = {
      role: nextRole,
      permissions:
        nextRole === "admin"
          ? []
          : req.body.permissions === undefined
            ? normalizePermissions(existingUser.permissions)
            : normalizePermissions(req.body.permissions),
      updatedAt: getTimestamp(),
      status: nextStatus,
    };

    if (req.body.vehicleId !== undefined) {
      const vehicleId =
        typeof req.body.vehicleId === "string" ? req.body.vehicleId.trim() : "";

      if (vehicleId) {
        updates.vehicleId = vehicleId;
      } else {
        updates.vehicleId = "";
      }
    }

    if (req.body.vehicleName !== undefined) {
      const vehicleName =
        typeof req.body.vehicleName === "string"
          ? req.body.vehicleName.trim()
          : "";

      if (vehicleName) {
        updates.vehicleName = vehicleName;
      } else {
        updates.vehicleName = "";
      }
    }

    const patches: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates))
      patches[`${account.path}/${key}`] = value;
    if (account.central) {
      const membershipPath = `control/memberships/${account.tenantId}/${account.identityId}`;
      patches[`${membershipPath}/role`] = updates.role;
      patches[`${membershipPath}/permissions`] = updates.permissions;
      patches[`${membershipPath}/updatedAt`] = updates.updatedAt;
      patches[`${membershipPath}/status`] = updates.status;
    }
    if (typeof req.body.password === "string" && req.body.password.trim()) {
      if (!isValidPasswordInput(req.body.password))
        return res.status(400).json({ error: "INVALID_PASSWORD" });
      // A company administrator cannot reset a shared person's global credential.
      if (
        account.central &&
        account.identity.managedByTenantId !== account.tenantId
      )
        return res
          .status(403)
          .json({ error: "SHARED_IDENTITY_PASSWORD_RESET_DENIED" });
      if (account.central) {
        const memberships = (await readObject("control/memberships")) || {};
        if (
          Object.entries(memberships).some(
            ([tenantId, members]) =>
              tenantId !== account.tenantId &&
              members &&
              typeof members === "object" &&
              Object.prototype.hasOwnProperty.call(members, account.identityId),
          )
        )
          return res
            .status(403)
            .json({ error: "SHARED_IDENTITY_PASSWORD_RESET_DENIED" });
      }
      const credentialPath = account.central
        ? `control/identities/${account.identityId}`
        : account.path;
      patches[`${credentialPath}/passwordHash`] = await hashPassword(
        req.body.password,
      );
      patches[`${credentialPath}/password`] = null;
      patches[`${credentialPath}/sessionVersion`] = randomUUID();
    }
    await writeAccountUpdates(patches);

    const updatedUser: InventoryUser = {
      ...existingUser,
      ...updates,
      username: existingUser.username || id,
    };

    res.json({
      message: "User updated successfully",
      data: toUserResponse(id, updatedUser),
    });
  } catch (error: any) {
    res.status(error instanceof AuthError ? error.status : 503).json({
      error:
        error instanceof AuthError ? error.code : "USER_UPDATE_UNAVAILABLE",
    });
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) return;

  const { id } = req.params;

  if (isInvalidUsername(id)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  if (currentUser.username === id || currentUser.userId === id) {
    return res.status(400).json({ error: "You cannot delete your own user" });
  }

  try {
    const account = await findAccount(getActiveTenantId(), id);
    if (!account) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingUser = account.membership as InventoryUser;
    const currentUser = getCurrentUserFromRequest(req)!;
    if (
      account.source === "legacy-root" &&
      id === (process.env.TRIAL_MANAGER_USERNAME || "and") &&
      currentUser.userId !== id &&
      !currentUser.platformPermissions?.includes("tenants.manage")
    )
      return res.status(403).json({ error: "PLATFORM_IDENTITY_PROTECTED" });

    if (normalizeRole(existingUser.role) === "admin") {
      const adminCount = countAdmins(await getUserEntries());

      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ error: "At least one admin user is required" });
      }
    }

    const patches: Record<string, any> = { [account.path]: null };
    if (account.central)
      patches[`control/memberships/${account.tenantId}/${account.identityId}`] =
        null;
    await writeAccountUpdates(patches);
    res.json({ message: "User deleted successfully" });
  } catch (error: any) {
    res.status(error instanceof AuthError ? error.status : 503).json({
      error:
        error instanceof AuthError ? error.code : "USER_DELETE_UNAVAILABLE",
    });
  }
};
