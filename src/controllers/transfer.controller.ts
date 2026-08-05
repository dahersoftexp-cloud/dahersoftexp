import { ref, push } from "../utils/tenantFirebase";
import { database } from "../firebaseConfig";

interface CreateTransferInput {
  productId: string;
  code: string;
  name: string;

  oldWarehouse: string;
  newWarehouse: string;

  quantity: number;
  amount: number;
  currency: string;

  stockBefore: number;
  stockAfter: number;

  performedBy?: string; // userId أو name
  referenceId?: string; // رقم الفاتورة أو العملية

  note?: string;
}

export const createTransferInternal = async (data: CreateTransferInput) => {
  try {
    const transferRef = await push(ref(database, "warehouseTransfers"), {
      productId: data.productId,
      productCode: data.code,
      productName: data.name,

      fromWarehouse: data.oldWarehouse,
      toWarehouse: data.newWarehouse,

      quantity: Number(data.quantity),
      cost: Number(data.amount || 0),
      currency: data.currency || "USD",

      stockBefore: Number(data.stockBefore),
      stockAfter: Number(data.stockAfter),

      performedBy: data.performedBy || "system",
      referenceId: data.referenceId || null,

      note: data.note || "",
      createdAt: Date.now(),
    });

    return {
      success: true,
      transferId: transferRef.key,
    };
  } catch (error) {
    console.error("❌ createTransferInternal error:", error);
    throw error;
  }
};
