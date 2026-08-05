import { Request, Response } from "express";
import { ref, get, rootRef, set } from "../utils/tenantFirebase";
import { generateToken } from "../utils/jwt";
import {
  DEFAULT_TENANT_ID,
  runWithTenant,
  sanitizeTenantId,
} from "../utils/tenantContext";

const normalizePermissions = (permissions: unknown): string[] => {
  if (!Array.isArray(permissions)) return [];

  return permissions
    .filter((permission): permission is string => typeof permission === "string")
    .map((permission) => permission.trim())
    .filter(Boolean);
};

const getStringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const parseLoginScope = (req: Request) => {
  const rawUsername = getStringValue(req.body?.username);
  const requestedTenantId = getStringValue(
    req.body?.tenantId ||
      req.body?.companyCode ||
      req.body?.trialId ||
      req.headers["x-inventory-tenant-id"] ||
      req.headers["x-tenant-id"] ||
      req.headers["x-company-code"],
  );

  if (!requestedTenantId) {
    const scopedUsername = rawUsername.match(/^([^:|/]+)[:|/](.+)$/);
    if (scopedUsername) {
      return {
        tenantId: sanitizeTenantId(scopedUsername[1]),
        username: scopedUsername[2].trim(),
      };
    }
  }

  return {
    tenantId: sanitizeTenantId(requestedTenantId || DEFAULT_TENANT_ID),
    username: rawUsername,
  };
};

const getTenantMetadata = async (tenantId: string) => {
  const snapshot = await get(rootRef(`trialTenants/${tenantId}`));
  return snapshot.exists() ? snapshot.val() : null;
};

const isExpired = (expiresAt: unknown) => {
  const expiresTime = new Date(String(expiresAt || "")).getTime();
  return Number.isFinite(expiresTime) && expiresTime <= Date.now();
};

export const login = async (req: Request, res: Response) => {
  const { username, tenantId } = parseLoginScope(req);
  const password = getStringValue(req.body?.password);

  try {
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const tenantMetadata = await getTenantMetadata(tenantId);
    if (tenantMetadata?.status && tenantMetadata.status !== "active") {
      return res.status(403).json({ error: "Trial is not active" });
    }

    if (tenantMetadata?.expiresAt && isExpired(tenantMetadata.expiresAt)) {
      return res.status(403).json({ error: "Trial has expired" });
    }

    const snapshot = await runWithTenant(tenantId, () =>
      get(ref(`users/${username}`)),
    );

    if (!snapshot.exists()) {
      return res.status(401).json({ error: "User not found" });
    }

    const user = snapshot.val();

    if (user.password !== password) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const userRole = user.role || "user";
    const permissions = normalizePermissions(user.permissions);
    const currentUsername = user.username || username;

    return res.json({
      message: "Login successful",
      token: generateToken({
        userId: currentUsername,
        username: currentUsername,
        tenantId,
        role: userRole,
        permissions,
      }),
      user: {
        id: username,
        username: currentUsername,
        tenantId,
        companyCode: tenantId,
        role: userRole,
        permissions,
        trialExpiresAt: tenantMetadata?.expiresAt || "",
        vehicleId: user.vehicleId || "",
        vehicleName: user.vehicleName || "",
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Login failed" });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { username, password, role, permissions } = req.body;

  try {
    const dbRef = ref(`users/${username}`);
    const snapshot = await get(dbRef);
    if (snapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    await set(dbRef, { username, password, role, permissions });
    return res.json({ message: "User created successfully" });
  } catch (error: any) {
    console.error("Create user error:", error);
    return res.status(500).json({ error: "User creation failed" });
  }
};
