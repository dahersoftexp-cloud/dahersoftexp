import { Warehouse } from "../types/warehouse";
import { getTenantDatabase } from "../tenancy/tenantDatabaseProvider";
import { validateRelativeDatabasePath } from "../tenancy/databasePath";
import { v5 as uuidv5 } from "uuid";
import { WarehouseError } from "./warehouseErrors";

const namespace = "4d6ae6b4-d9c4-59d3-9dc3-d271b7004653";
const normalizeName = (name: string) =>
  name.trim().normalize("NFC").toLowerCase();
const mutableFields = [
  "location",
  "isActive",
  "plateNumber",
  "driverId",
  "driverName",
  "defaultPaymentAccountId",
  "defaultReceivableAccountId",
  "defaultSalesAccountId",
];
const assertId = (id: string) => {
  try {
    validateRelativeDatabasePath(id);
    if (id.includes("/")) throw new Error();
  } catch {
    throw new WarehouseError(400, "INVALID_WAREHOUSE_ID");
  }
};
const assertObject = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WarehouseError(503, "WAREHOUSE_WRITE_UNAVAILABLE");
  return value;
};
const revisionOf = (value: Record<string, any>) => {
  const revision = value.revision ?? 0;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    throw new WarehouseError(503, "WAREHOUSE_WRITE_UNAVAILABLE");
  return revision;
};
const normalizeWriteError = (error: unknown, id: string): never => {
  if (error instanceof WarehouseError) throw error;
  const code =
    (error as { code?: string; message?: string })?.code ||
    (error as Error)?.message;
  if (code === "SERVER_DATABASE_WRITE_OUTCOME_UNKNOWN")
    throw new WarehouseError(503, "WAREHOUSE_WRITE_OUTCOME_UNKNOWN", id);
  if (code === "TENANT_WRITE_CONFLICT")
    throw new WarehouseError(409, "WAREHOUSE_CONFLICT", id);
  throw error;
};

export const getWarehouseRepository = () => {
  const database = getTenantDatabase();
  const updateRecord = async (
    id: string,
    patch: Partial<Warehouse>,
    options: {
      expectedRevision?: number;
      expectedType?: "standard" | "vehicle";
      archive?: boolean;
    } = {},
  ) => {
    assertId(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new WarehouseError(400, "INVALID_WAREHOUSE_INPUT");
    const keys = Object.keys(patch);
    if (
      keys.some((key) =>
        [
          "id",
          "name",
          "type",
          "createdDate",
          "revision",
          "driverAssignmentManaged",
        ].includes(key),
      )
    )
      throw new WarehouseError(400, "WAREHOUSE_IDENTITY_IMMUTABLE");
    if (
      keys.some((key) => !mutableFields.includes(key)) ||
      keys.some((key) =>
        key === "isActive"
          ? typeof patch.isActive !== "boolean"
          : typeof (patch as any)[key] !== "string",
      ) ||
      (options.expectedRevision !== undefined &&
        (!Number.isSafeInteger(options.expectedRevision) ||
          options.expectedRevision < 0))
    )
      throw new WarehouseError(400, "INVALID_WAREHOUSE_INPUT");
    const now = new Date().toLocaleString();
    let baseline: Record<string, any> | undefined;
    try {
      const result = await database.transact(`warehouses/${id}`, (raw) => {
        if (raw === null) return undefined;
        const current = assertObject(raw);
        const revision = revisionOf(current);
        if (
          options.expectedType &&
          (current.type || "standard") !== options.expectedType
        )
          throw new WarehouseError(409, "VEHICLE_MANAGED_SEPARATELY");
        if (
          options.expectedRevision !== undefined &&
          revision !== options.expectedRevision
        )
          throw new WarehouseError(409, "WAREHOUSE_CONFLICT", id);
        if (
          baseline &&
          keys.some(
            (key) =>
              current[key] !== baseline![key] &&
              current[key] !== (patch as any)[key],
          )
        )
          throw new WarehouseError(409, "WAREHOUSE_CONFLICT", id);
        baseline ||= current;
        const managedAssignment =
          current.type === "vehicle" && keys.includes("driverId");
        if (
          !options.archive &&
          !managedAssignment &&
          keys.every((key) => current[key] === (patch as any)[key])
        )
          return undefined;
        if (options.archive && current.isArchived === true) return undefined;
        const next = {
          ...current,
          ...patch,
          updatedDate: now,
          revision: revision + 1,
        };
        if (managedAssignment) next.driverAssignmentManaged = true;
        if (options.archive) {
          next.isActive = false;
          next.isArchived = true;
          next.archivedAt = new Date().toISOString();
        } else if (patch.isActive === true) {
          next.isArchived = false;
          delete next.archivedAt;
        }
        return next;
      });
      return result.value as Warehouse | null;
    } catch (error) {
      return normalizeWriteError(error, id);
    }
  };
  return Object.freeze({
    list: async (): Promise<Warehouse[]> => {
      const value = await database.read("warehouses");
      if (value === null) return [];
      if (typeof value !== "object") throw new Error("INVALID_WAREHOUSE_STORE");
      // Preserve the existing API: fields, IDs, ordering and inactive rows.
      return Object.values(value) as Warehouse[];
    },
    findById: async (id: string): Promise<Warehouse | null> => {
      assertId(id);
      const value = await database.read(`warehouses/${id}`);
      if (value === null) return null;
      if (typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_WAREHOUSE_STORE");
      return value as Warehouse;
    },
    create: async (
      data: Omit<Warehouse, "id" | "createdDate" | "updatedDate" | "revision">,
    ): Promise<Warehouse> => {
      if (
        !data ||
        typeof data.name !== "string" ||
        !data.name.trim() ||
        /[.#$\[\]\/\\\u0000-\u001f\u007f]/.test(data.name) ||
        Buffer.byteLength(data.name, "utf8") > 768 ||
        typeof data.isActive !== "boolean" ||
        (data.location !== undefined && typeof data.location !== "string") ||
        (data.type !== undefined &&
          !["standard", "vehicle"].includes(data.type))
      )
        throw new WarehouseError(400, "INVALID_WAREHOUSE_INPUT");
      const name = data.name.trim();
      const id = uuidv5(
        JSON.stringify([database.tenantId, normalizeName(name)]),
        namespace,
      );
      const now = new Date().toLocaleString();
      const value: Warehouse = {
        ...data,
        id,
        name,
        createdDate: now,
        updatedDate: now,
        revision: 1,
        ...(data.type === "vehicle" ? { driverAssignmentManaged: true } : {}),
      };
      const existing = await database.read("warehouses");
      const duplicate =
        existing === null
          ? undefined
          : Object.entries(assertObject(existing)).find(
              ([, item]: any) =>
                typeof item?.name === "string" &&
                normalizeName(item.name) === normalizeName(name),
            );
      if (duplicate)
        throw new WarehouseError(409, "WAREHOUSE_ALREADY_EXISTS", duplicate[0]);
      try {
        await database.transact(`warehouses/${id}`, (current) => {
          if (current !== null)
            throw new WarehouseError(409, "WAREHOUSE_ALREADY_EXISTS", id);
          return value;
        });
        return value;
      } catch (error) {
        return normalizeWriteError(error, id);
      }
    },
    update: updateRecord,
    archive: (
      id: string,
      options: {
        expectedRevision?: number;
        expectedType?: "standard" | "vehicle";
      } = {},
    ) => updateRecord(id, { isActive: false }, { ...options, archive: true }),
  });
};
