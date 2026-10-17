import { Request, Response } from "express";
import { Warehouse } from "../types/warehouse";
import { getWarehouseRepository } from "../repositories/warehouses.repository";
import { WarehouseError } from "../repositories/warehouseErrors";
import { sendWarehouseError } from "./warehouseErrorResponse";

/* =========================================================
   ✅ 1. جلب جميع المستودعات
   ========================================================= */
export const getAll = async (_req: Request, res: Response) => {
  try {
    res.json(await getWarehouseRepository().list());
  } catch (error: any) {
    res.status(503).json({ error: "WAREHOUSE_READ_UNAVAILABLE" });
  }
};

/* =========================================================
   ✅ 2. إنشاء مستودع جديد
   ========================================================= */
export const create = async (req: Request, res: Response) => {
  try {
    const newWarehouse = await getWarehouseRepository().create({
      name: req.body?.name,
      location: req.body?.location ?? "",
      isActive: true,
    });

    res.json({
      message: "✅ تم إنشاء المستودع بنجاح",
      data: newWarehouse,
    });
  } catch (error: any) {
    sendWarehouseError(res, error);
  }
};

export const updateWarehouse = async (req: Request, res: Response) => {
  try {
    if (
      !req.body ||
      Object.keys(req.body).some(
        (key) => !["location", "isActive", "expectedRevision"].includes(key),
      )
    )
      throw new WarehouseError(400, "INVALID_WAREHOUSE_INPUT");
    const patch = {
      ...(req.body.location !== undefined
        ? { location: req.body.location }
        : {}),
      ...(req.body.isActive !== undefined
        ? { isActive: req.body.isActive }
        : {}),
    };
    const value = await getWarehouseRepository().update(req.params.id, patch, {
      expectedRevision: req.body.expectedRevision,
      expectedType: "standard",
    });
    if (!value) throw new WarehouseError(404, "WAREHOUSE_NOT_FOUND");
    return res.json({ message: "تم تحديث المستودع", data: value });
  } catch (error) {
    return sendWarehouseError(res, error);
  }
};

export const archiveWarehouse = async (req: Request, res: Response) => {
  try {
    const value = await getWarehouseRepository().archive(req.params.id, {
      expectedRevision: req.body?.expectedRevision,
      expectedType: "standard",
    });
    if (!value) throw new WarehouseError(404, "WAREHOUSE_NOT_FOUND");
    return res.json({
      message: "تمت أرشفة المستودع مع حفظ بياناته",
      data: value,
    });
  } catch (error) {
    return sendWarehouseError(res, error);
  }
};

/* =========================================================
   ✅ 3. إنشاء مستودع داخليًا
   ========================================================= */
export const createWarehouseInternal = async (
  data: Omit<Warehouse, "id" | "createdDate" | "updatedDate">,
): Promise<Warehouse> => {
  return getWarehouseRepository().create(data);
};

/* =========================================================
   ✅ 4. تحديث مستودع داخليًا
   ========================================================= */
export const updateWarehouseInternal = async (
  id: string,
  updates: Partial<Warehouse>,
): Promise<Warehouse | null> => {
  return getWarehouseRepository().update(id, updates);
};

/* =========================================================
   ✅ 5. حذف مستودع داخليًا
   ⚠️ يفضل تعطيله بدل الحذف الحقيقي
   ========================================================= */
export const deleteWarehouseInternal = async (id: string): Promise<boolean> => {
  // Compatibility entry point: deletion now archives to retain invoice links.
  return (await getWarehouseRepository().archive(id)) !== null;
};

/* =========================================================
   ✅ 6. جلب جميع المستودعات داخليًا
   ========================================================= */
export const getAllWarehousesInternal = async (): Promise<Warehouse[]> => {
  return getWarehouseRepository().list();
};

/* =========================================================
   ✅ 7. جلب مستودع واحد داخليًا
   ========================================================= */
export const getWarehouseByIdInternal = async (
  id: string,
): Promise<Warehouse | null> => {
  return getWarehouseRepository().findById(id);
};

/* =========================================================
   ✅ 8. تعطيل مستودع بدل الحذف (Best Practice)
   ========================================================= */
export const deactivateWarehouseInternal = async (
  id: string,
): Promise<Warehouse | null> => {
  return updateWarehouseInternal(id, { isActive: false });
};

/* =========================================================
   🚀 إنشاء المستودعات تلقائيًا من البيانات الحالية
   ========================================================= */
export const migrateWarehousesFromExistingData = async (
  _req: Request,
  res: Response,
) => {
  return res.status(410).json({ error: "ENDPOINT_RETIRED" });
};
