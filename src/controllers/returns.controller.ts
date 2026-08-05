import { Request, Response } from "express";
import { getDatabase, ref, get, set, update } from "../utils/tenantFirebase";
import { v4 as uuidv4 } from "uuid";
import { resolveProductsWarehouseKey } from "./products.controller";

export interface ReturnData {
  productCode: string;
  productId: string;
  warehouse: string;
  qty: number;
  returnValue?: number;
  type: "sale-return" | "purchase-return";
  referenceId?: string | null;
  reason?: string;
}

export interface ReturnRecord extends ReturnData {
  id: string;
  createdDate: string;
}

const toNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const findProductForReturn = async ({
  db,
  productCode,
  productId,
  warehouse,
}: {
  db: ReturnType<typeof getDatabase>;
  productCode?: string;
  productId?: string;
  warehouse: string;
}) => {
  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productsRef = ref(db, `products/${warehouseKey}`);
  const productsSnap = await get(productsRef);

  if (!productsSnap.exists()) {
    return null;
  }

  const products = productsSnap.val() as Record<string, any>;
  const productEntry = Object.entries(products).find(([key, product]) => (
    key === productId ||
    key === productCode ||
    product?.id === productId ||
    product?.id === productCode ||
    product?.code === productCode
  ));

  if (!productEntry) {
    return null;
  }

  const [productKey, product] = productEntry;
  return {
    warehouseKey,
    productKey,
    product: {
      ...product,
      id: product?.id || productKey,
      code: product?.code || productCode || productKey,
    },
  };
};

function applyReturnToProduct(
  product: any,
  type: "sale-return" | "purchase-return",
  qty: number
) {
  const currentQuantity = toNumber(product.quantity);

  if (type === "sale-return") {
    product.quantity = currentQuantity + qty;
  } else if (type === "purchase-return") {
    if (currentQuantity < qty) {
      throw new Error("Insufficient product quantity for purchase return");
    }
    product.quantity = currentQuantity - qty;
  } else {
    throw new Error("Invalid return type");
  }
}

export const getAllReturns = async (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const returnsRef = ref(db, "returns");
    const snapshot = await get(returnsRef);

    const returns = snapshot.exists() ? Object.values(snapshot.val()) : [];
    res.json(returns);
  } catch (error: any) {
    res.status(500).json({
      message: "Failed to fetch returns",
      error: error.message,
    });
  }
};

export const getReturnById = async (req: Request, res: Response) => {
  const id = req.params.id || req.body?.id;
  if (!id) return res.status(400).json({ message: "return id is required" });

  try {
    const db = getDatabase();
    const returnRef = ref(db, `returns/${id}`);
    const snapshot = await get(returnRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "Return record not found" });
    }

    res.json(snapshot.val());
  } catch (error: any) {
    res
      .status(500)
      .json({ message: "Failed to fetch return record", error: error.message });
  }
};

export const createReturn = async (req: Request, res: Response) => {
  const { productCode, productId, warehouse, qty, type, referenceId, reason } = req.body;

  if ((!productCode && !productId) || !warehouse || !qty || !type) {
    return res
      .status(400)
      .json({ message: "productCode/productId, warehouse, qty, type are required" });
  }

  try {
    const db = getDatabase();
    const foundProduct = await findProductForReturn({
      db,
      productCode,
      productId,
      warehouse,
    });

    if (!foundProduct) {
      return res
        .status(404)
        .json({ message: "Product not found in warehouse" });
    }

    const { warehouseKey, productKey, product } = foundProduct;
    const productRef = ref(db, `products/${warehouseKey}/${productKey}`);
    const returnQty = Math.abs(toNumber(qty));

    applyReturnToProduct(product, type, returnQty);
    product.updatedDate = new Date().toLocaleString();

    await update(productRef, product);

    const returnId = uuidv4();
    const now = new Date().toLocaleString();

    const returnRecord: ReturnRecord = {
      id: returnId,
      productCode: product.code || productCode || productKey,
      productId: product.id || productKey,
      warehouse,
      qty: returnQty,
      type,
      referenceId: referenceId || null,
      reason: reason || "",
      createdDate: now,
    };

    await set(ref(db, `returns/${returnId}`), returnRecord);

    res.json({
      message: "Return record created",
      data: { returnRecord, product },
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: "Failed to create return", error: error.message });
  }
};

export const createReturnInternal = async (newReturn: ReturnData) => {
  try {
    const db = getDatabase();
    const foundProduct = await findProductForReturn({
      db,
      productCode: newReturn.productCode,
      productId: newReturn.productId,
      warehouse: newReturn.warehouse,
    });

    if (!foundProduct) {
      throw new Error("Product not found in warehouse");
    }

    const { warehouseKey, productKey, product } = foundProduct;
    const productRef = ref(db, `products/${warehouseKey}/${productKey}`);
    const now = new Date().toLocaleString();
    const returnQty = Math.abs(toNumber(newReturn.qty));

    applyReturnToProduct(product, newReturn.type, returnQty);
    product.updatedDate = now;

    await update(productRef, product);

    const id = uuidv4();
    const returnRecord: ReturnRecord = {
      ...newReturn,
      productCode: product.code || newReturn.productCode || productKey,
      productId: product.id || newReturn.productId || productKey,
      qty: returnQty,
      id,
      createdDate: now,
    };

    await set(ref(db, `returns/${id}`), returnRecord);

    return { returnRecord, product };
  } catch (error: any) {
    throw new Error(
      `Failed to execute createReturnInternal: ${error.message}`
    );
  }
};
