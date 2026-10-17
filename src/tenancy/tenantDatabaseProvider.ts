import {
  readServerJson,
  readServerVersioned,
  compareAndSetServerJson,
} from "../infrastructure/serverDatabase";
import { validateRelativeDatabasePath } from "./databasePath";
import { getActiveTenantId, TENANTS_ROOT } from "../utils/tenantContext";
import { resolveActiveTenant } from "./tenantResolver";
import { currentFinancialUnit, readFinancialSnapshot } from "./financialUnit";

export interface TenantDatabaseReader {
  readonly tenantId: string;
  read(path: string): Promise<unknown>;
}
export interface TenantDatabase extends TenantDatabaseReader {
  transact(
    path: string,
    updater: (current: unknown) => unknown,
  ): Promise<{ committed: boolean; value: unknown; previous: unknown }>;
}
export const getTenantDatabase = (): TenantDatabase => {
  const tenant = resolveActiveTenant();
  const assertContext = () => {
    if (getActiveTenantId() !== tenant.tenantId)
      throw new Error("TENANT_CONTEXT_MISMATCH");
  };
  return Object.freeze({
    tenantId: tenant.tenantId,
    read: async (path: string) => {
      assertContext();
      validateRelativeDatabasePath(path);
      if (
        [
          TENANTS_ROOT,
          "control",
          "users",
          "trialTenants",
          "trialTemplates",
          "tenantAliases",
        ].includes(path.split("/")[0])
      )
        throw new Error("RESERVED_TENANT_DATABASE_PATH");
      const value = currentFinancialUnit()
        ? readFinancialSnapshot(`${tenant.rootPath}/${path}`)
        : await readServerJson(`${tenant.rootPath}/${path}`);
      assertContext();
      return value;
    },
    transact: async (path: string, updater: (current: unknown) => unknown) => {
      assertContext();
      validateRelativeDatabasePath(path);
      // Enable writes one unit at a time; no company-root or financial writes.
      if (!/^warehouses\/[^/]+$/.test(path))
        throw new Error("TENANT_WRITE_PATH_NOT_ENABLED");
      const target = `${tenant.rootPath}/${path}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        assertContext();
        const revision = await readServerVersioned(target);
        assertContext();
        const next = updater(structuredClone(revision.value));
        if (next === undefined)
          return {
            committed: false,
            value: revision.value,
            previous: revision.value,
          };
        if (next === null)
          throw new Error("WAREHOUSE_PHYSICAL_DELETE_DISABLED");
        assertContext();
        const committed = await compareAndSetServerJson(target, revision, next);
        assertContext();
        if (committed)
          return { committed: true, value: next, previous: revision.value };
      }
      throw new Error("TENANT_WRITE_CONFLICT");
    },
  });
};
