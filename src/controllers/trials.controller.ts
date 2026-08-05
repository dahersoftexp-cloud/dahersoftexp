import { Request, Response } from "express";
import { get, rootRef, set, update } from "../utils/tenantFirebase";
import { v4 as uuidv4 } from "uuid";
import { sanitizeTenantId } from "../utils/tenantContext";
import { buildDefaultAccounts } from "../utils/defaultAccounts";

const DEFAULT_TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);

const getStringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const requireCreationSecret = (req: Request, res: Response) => {
  const requiredSecret = getStringValue(process.env.TRIAL_CREATION_SECRET);
  if (!requiredSecret) return true;

  const providedSecret = getStringValue(req.headers["x-trial-secret"]);
  if (providedSecret === requiredSecret) return true;

  res.status(401).json({ error: "Trial creation is not authorized" });
  return false;
};

const generateTenantId = (value: unknown) => {
  const requestedId = getStringValue(value);
  return requestedId
    ? sanitizeTenantId(requestedId)
    : `trial-${uuidv4().slice(0, 8)}`;
};

const generatePassword = () => uuidv4().replace(/-/g, "").slice(0, 12);

const getTrialDurationDays = (value: unknown) => {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) return DEFAULT_TRIAL_DAYS;
  return Math.min(Math.ceil(parsedValue), 90);
};

const getTrialTemplate = async (templateId: string) => {
  const snapshot = await get(rootRef(`trialTemplates/${templateId}`));
  return snapshot.exists() && typeof snapshot.val() === "object"
    ? snapshot.val()
    : {};
};

export const createTrial = async (req: Request, res: Response) => {
  if (!requireCreationSecret(req, res)) return;

  try {
    const tenantId = generateTenantId(
      req.body?.tenantId || req.body?.companyCode || req.body?.trialId,
    );
    const adminUsername = getStringValue(req.body?.username) || "admin";
    const adminPassword = getStringValue(req.body?.password) || generatePassword();
    const companyName = getStringValue(req.body?.companyName) || tenantId;
    const templateId =
      getStringValue(req.body?.templateId) ||
      getStringValue(process.env.DEFAULT_TRIAL_TEMPLATE_ID) ||
      "default";
    const durationDays = getTrialDurationDays(req.body?.durationDays);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + durationDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const tenantSnapshot = await get(rootRef(`tenants/${tenantId}`));
    if (tenantSnapshot.exists()) {
      return res.status(409).json({ error: "Trial tenant already exists" });
    }

    const templateData = await getTrialTemplate(templateId);
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
        ...((templateData as any).users || {}),
        [adminUsername]: {
          username: adminUsername,
          password: adminPassword,
          role: "admin",
          permissions: [],
          tenantId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      },
    };

    await update(rootRef(), {
      [`trialTenants/${tenantId}`]: metadata,
      [`tenantAliases/${tenantId}`]: tenantId,
    });
    await set(rootRef(`tenants/${tenantId}`), tenantData);

    return res.status(201).json({
      tenantId,
      companyCode: tenantId,
      username: adminUsername,
      password: adminPassword,
      expiresAt,
      loginPath: `/login?tenant=${tenantId}`,
    });
  } catch (error: any) {
    console.error("Create trial error:", error);
    return res.status(500).json({
      error: "Could not create trial",
      details: error?.message,
    });
  }
};
