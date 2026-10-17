import { CurrentUser } from "../utils/currentUser";
import { LEGACY_ROOT_TENANT_ID } from "../utils/tenantContext";

export const canManageTenants = (user: CurrentUser) =>
  Boolean(
    user.platformPermissions?.includes("tenants.manage") ||
    (user.source === "legacy-root" &&
      user.role === "admin" &&
      user.tenantId === LEGACY_ROOT_TENANT_ID &&
      user.username === (process.env.TRIAL_MANAGER_USERNAME?.trim() || "and")),
  );
