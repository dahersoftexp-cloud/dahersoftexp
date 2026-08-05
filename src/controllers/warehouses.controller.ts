import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import { ref, get, set, update, remove } from "../utils/tenantFirebase";
import { database } from "../firebaseConfig";
import { Warehouse } from "../types/warehouse";

/* =========================================================
   ✅ 1. جلب جميع المستودعات
   ========================================================= */
export const getAll = async (_req: Request, res: Response) => {
  try {
    const dbRef = ref(database, "warehouses");
    const snapshot = await get(dbRef);

    res.json(snapshot.exists() ? Object.values(snapshot.val()) : []);
  } catch (error: any) {
    console.error("Error fetching warehouses:", error);
    res.status(500).json({ error: error.message });
  }
};

/* =========================================================
   ✅ 2. إنشاء مستودع جديد
   ========================================================= */
export const create = async (req: Request, res: Response) => {
  try {
    const now = new Date().toLocaleString();
    const id = uuidv4();

    const newWarehouse: Warehouse = {
      id,
      name: req.body.name,
      location: req.body.location || "",
      isActive: true,
      createdDate: now,
      updatedDate: now,
    };

    await set(ref(database, `warehouses/${id}`), newWarehouse);

    res.json({
      message: "✅ تم إنشاء المستودع بنجاح",
      data: newWarehouse,
    });
  } catch (error: any) {
    console.error("Error creating warehouse:", error);
    res.status(500).json({ error: error.message });
  }
};

/* =========================================================
   ✅ 3. إنشاء مستودع داخليًا
   ========================================================= */
export const createWarehouseInternal = async (
  data: Omit<Warehouse, "id" | "createdDate" | "updatedDate">,
): Promise<Warehouse> => {
  const id = uuidv4();
  const now = new Date().toLocaleString();

  const warehouse: Warehouse = {
    ...data,
    id,
    createdDate: now,
    updatedDate: now,
  };

  await set(ref(database, `warehouses/${id}`), warehouse);
  return warehouse;
};

/* =========================================================
   ✅ 4. تحديث مستودع داخليًا
   ========================================================= */
export const updateWarehouseInternal = async (
  id: string,
  updates: Partial<Warehouse>,
): Promise<Warehouse | null> => {
  const dbRef = ref(database, `warehouses/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return null;

  const warehouse = snapshot.val() as Warehouse;

  const updatedWarehouse: Warehouse = {
    ...warehouse,
    ...updates,
    updatedDate: new Date().toLocaleString(),
  };

  await update(dbRef, updatedWarehouse);
  return updatedWarehouse;
};

/* =========================================================
   ✅ 5. حذف مستودع داخليًا
   ⚠️ يفضل تعطيله بدل الحذف الحقيقي
   ========================================================= */
export const deleteWarehouseInternal = async (id: string): Promise<boolean> => {
  const dbRef = ref(database, `warehouses/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return false;

  await remove(dbRef);
  return true;
};

/* =========================================================
   ✅ 6. جلب جميع المستودعات داخليًا
   ========================================================= */
export const getAllWarehousesInternal = async (): Promise<Warehouse[]> => {
  const dbRef = ref(database, "warehouses");
  const snapshot = await get(dbRef);
  return snapshot.exists() ? Object.values(snapshot.val()) : [];
};

/* =========================================================
   ✅ 7. جلب مستودع واحد داخليًا
   ========================================================= */
export const getWarehouseByIdInternal = async (
  id: string,
): Promise<Warehouse | null> => {
  const dbRef = ref(database, `warehouses/${id}`);
  const snapshot = await get(dbRef);
  return snapshot.exists() ? snapshot.val() : null;
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
  res: Response
) => {
  try {
    const warehouseSet = new Set<string>();

    console.log("🔍 Scanning existing warehouses...");

    // 1️⃣ من products
    const productsSnap = await get(ref(database, "products"));
    if (productsSnap.exists()) {
      productsSnap.forEach(warehouseNode => {
        if (warehouseNode.key) {
          warehouseSet.add(warehouseNode.key);
        }
      });
    }

    // 2️⃣ من purchases
    const purchasesSnap = await get(ref(database, "purchases"));
    if (purchasesSnap.exists()) {
      purchasesSnap.forEach(p => {
        const w = p.val()?.warehouse;
        if (w) warehouseSet.add(w);
      });
    }

    // 3️⃣ من returns
    const returnsSnap = await get(ref(database, "returns"));
    if (returnsSnap.exists()) {
      returnsSnap.forEach(r => {
        const w = r.val()?.warehouse;
        if (w) warehouseSet.add(w);
      });
    }

    // 4️⃣ من sells → products[]
    const sellsSnap = await get(ref(database, "sells"));
    if (sellsSnap.exists()) {
      sellsSnap.forEach(sell => {
        const products = sell.val()?.products || [];
        products.forEach((p: any) => {
          if (p.warehouse) warehouseSet.add(p.warehouse);
        });
      });
    }

    const warehouses = [...warehouseSet].filter(Boolean);

    if (!warehouses.length) {
      return res.json({
        message: "⚠️ لم يتم العثور على أي مستودعات.",
        count: 0,
      });
    }

    const now = new Date().toLocaleString();
    const updates: Record<string, any> = {};

   const skipped: string[] = [];

   warehouses.forEach((rawName) => {
     const cleanName = String(rawName).trim();

     if (!cleanName) {
       skipped.push(rawName);
       return;
     }

     // 🔹 إنشاء id بطريقة آمنة
     let id = cleanName
       .toLowerCase()
       .replace(/\s+/g, "_") // استبدال المسافات بـ _
       .replace(/[^a-z0-9_]/g, ""); // إزالة الرموز غير المسموح بها

     // 🔹 إذا أصبح فارغ بعد التنظيف، نضيف رقم فريد صغير
     if (!id) {
       id = "warehouse_" + Math.floor(Math.random() * 10000);
     }

     // 🔹 إذا هذا الـ id موجود مسبقًا في updates، أضف suffix لتجنب الاستبدال
     let finalId = id;
     let counter = 1;
     while (updates[finalId]) {
       finalId = id + "_" + counter;
       counter++;
     }

     updates[finalId] = {
       id: finalId,
       name: cleanName,
       location: "",
       isActive: true,
       createdDate: now,
       updatedDate: now,
     };
   });


    if (!Object.keys(updates).length) {
      return res.status(400).json({
        message: "❌ لم يتم إنشاء أي مستودع بسبب أسماء غير صالحة",
        skipped,
      });
    }


    await update(ref(database, "warehouses"), updates);

    res.json({
      message: "✅ تم إنشاء المستودعات بنجاح",
      count: warehouses.length,
      warehouses,
    });
  } catch (error: any) {
    console.error("❌ Migration error:", error);
    res.status(500).json({ error: error.message });
  }
};
