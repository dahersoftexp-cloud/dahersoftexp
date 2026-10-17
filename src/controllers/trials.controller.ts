import { Request, Response } from "express";
import { rootRef, rootGet as get, rootUpdate as update, rootRunTransaction as runTransaction } from "../tenancy/controlDatabase";
import { v4 as uuidv4 } from "uuid";
import {
  DEFAULT_TENANT_ID,
  TENANTS_ROOT,
  validateTenantId,
} from "../utils/tenantContext";
import { buildDefaultAccounts } from "../utils/defaultAccounts";
import { getCurrentUserFromRequest } from "../utils/currentUser";
import { isUserKey, prepareManagedAccount } from "../auth/accounts";
import { isValidPasswordInput } from "../auth/passwords";
import { canManageTenants } from "../auth/platformPermissions";

const DEFAULT_TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

const getStringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const isTrialManagerRequest = (req: Request) => {
  const currentUser = getCurrentUserFromRequest(req);
  return currentUser && canManageTenants(currentUser);
};

const requireTrialManager = (req: Request, res: Response) => {
  if (isTrialManagerRequest(req)) return true;

  res.status(403).json({ error: "Trial manager permission is required" });
  return false;
};

const generateTenantId = (value: unknown) => {
  const requestedId = getStringValue(value);
  return requestedId
    ? validateTenantId(requestedId.toLowerCase())
    : `trial-${uuidv4().slice(0, 8)}`;
};

const generatePassword = () => uuidv4().replace(/-/g, "").slice(0, 12);

const getTrialDurationDays = (value: unknown) => {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0)
    return DEFAULT_TRIAL_DAYS;
  return Math.min(Math.ceil(parsedValue), 90);
};

const getTrialTemplate = async (templateId: string) => {
  const snapshot = await get(rootRef(`trialTemplates/${templateId}`));
  return snapshot.exists() && typeof snapshot.val() === "object"
    ? snapshot.val()
    : {};
};

export const getTrials = async (req: Request, res: Response) => {
  if (!requireTrialManager(req, res)) return;

  try {
    const snapshot = await get(rootRef("trialTenants"));
    const trials = snapshot.exists()
      ? Object.entries(snapshot.val() as Record<string, any>).map(
          ([tenantId, trial]) => ({
            tenantId,
            companyCode: trial?.companyCode || tenantId,
            companyName: trial?.companyName || tenantId,
            status: trial?.status || "active",
            templateId: trial?.templateId || "default",
            adminUsername: trial?.adminUsername || "admin",
            createdAt: trial?.createdAt || "",
            expiresAt: trial?.expiresAt || "",
            durationDays: trial?.durationDays || "",
          }),
        )
      : [];

    trials.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
    return res.json({ trials });
  } catch (error: any) {
    return res.status(503).json({ error: "Could not list trials" });
  }
};

export const createTrial = async (req: Request, res: Response) => {
  if (!requireTrialManager(req, res)) return;

  try {
    const tenantId = generateTenantId(
      req.body?.tenantId || req.body?.companyCode || req.body?.trialId,
    );
    const adminUsername = getStringValue(req.body?.username) || "admin";
    const adminPassword =
      getStringValue(req.body?.password) || generatePassword();
    if (!isUserKey(adminUsername) || !isValidPasswordInput(adminPassword))
      return res.status(400).json({ error: "INVALID_ADMIN_CREDENTIALS" });
    const companyName = getStringValue(req.body?.companyName) || tenantId;
    const templateId =
      getStringValue(req.body?.templateId) ||
      getStringValue(process.env.DEFAULT_TRIAL_TEMPLATE_ID) ||
      "default";
    if (!isUserKey(templateId))
      return res.status(400).json({ error: "INVALID_TEMPLATE_ID" });
    const durationDays = getTrialDurationDays(req.body?.durationDays);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + durationDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const tenantSnapshot = await get(rootRef(`${TENANTS_ROOT}/${tenantId}`));
    if (tenantSnapshot.exists()) {
      return res.status(409).json({ error: "Trial tenant already exists" });
    }

    const templateData = await getTrialTemplate(templateId);
    const prepared = await prepareManagedAccount(
      tenantId,
      adminUsername,
      adminPassword,
      { role: "admin", permissions: [] },
    );
    const metadata = {
      tenantId,
      companyCode: tenantId,
      companyName,
      status: "active",
      templateId,
      createdAt: now.toISOString(),
      expiresAt,
      durationDays,
      adminUsername,
    };

    const tenantData = {
      ...templateData,
      accounts: {
        ...((templateData as any).accounts || {}),
        ...buildDefaultAccounts(now.toISOString()),
      },
      settings: {
        ...(templateData as any).settings,
        trial: metadata,
      },
      users: {
        [adminUsername]: prepared.profile,
      },
    };

    const tenantPath = `${TENANTS_ROOT}/${tenantId}`;
    const reservation = await runTransaction(rootRef(tenantPath), (current) =>
      current === null ? { settings: { provisioning: "pending" } } : undefined,
    );
    if (!reservation.committed)
      return res.status(409).json({ error: "Trial tenant already exists" });
    await update(rootRef(), {
      ...prepared.updates,
      [tenantPath]: tenantData,
      [`trialTenants/${tenantId}`]: metadata,
      [`tenantAliases/${tenantId}`]: tenantId,
    });

    return res.status(201).json({
      tenantId,
      companyCode: tenantId,
      username: adminUsername,
      password: adminPassword,
      expiresAt,
      loginPath: `/#/login?tenant=${tenantId}`,
    });
  } catch (error: any) {
    return res.status(error?.message === "INVALID_TENANT_ID" ? 400 : 503).json({
      error:
        error?.message === "INVALID_TENANT_ID"
          ? "INVALID_TENANT_ID"
          : "Could not create trial",
    });
  }
};

export const deleteTrial = async (req: Request, res: Response) => {
  if (!requireTrialManager(req, res)) return;

  try {
    const tenantId = validateTenantId(req.params.tenantId || "");

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }

    if (tenantId === DEFAULT_TENANT_ID) {
      return res
        .status(400)
        .json({ error: "Default tenant cannot be deleted" });
    }

    await update(rootRef(), {
      [`${TENANTS_ROOT}/${tenantId}`]: null,
      [`control/memberships/${tenantId}`]: null,
      [`trialTenants/${tenantId}`]: null,
      [`tenantAliases/${tenantId}`]: null,
    });

    return res.json({ message: "Trial tenant deleted", tenantId });
  } catch (error: any) {
    return res.status(error?.message === "INVALID_TENANT_ID" ? 400 : 503).json({
      error:
        error?.message === "INVALID_TENANT_ID"
          ? "INVALID_TENANT_ID"
          : "Could not delete trial",
    });
  }
};
