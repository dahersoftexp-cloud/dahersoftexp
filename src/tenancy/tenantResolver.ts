import {
  getActiveTenantId,
  getTenantDatabasePath,
} from "../utils/tenantContext";

// Destinations are server-owned. This first increment supports the shared DB only.
export const resolveActiveTenant = () => {
  const tenantId = getActiveTenantId();
  return Object.freeze({
    tenantId,
    databaseKey: "shared" as const,
    rootPath: getTenantDatabasePath("", tenantId),
  });
};
