import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { get, ref, remove, set } from "../utils/tenantFirebase";
import { database } from "../firebaseConfig";

type ExchangeRecord = Record<string, any> & {
  id?: string;
  amount_to?: number;
};

const getCollectionValues = async (path: string) => {
  const snapshot = await get(ref(database, path));
  return snapshot.exists() ? Object.values(snapshot.val()) : [];
};

export const getAllExchange = async (_req: Request, res: Response) => {
  try {
    const exchanges = await getCollectionValues("exchange");
    res.json(exchanges);
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Failed to fetch exchanges" });
  }
};

export const getAllDoneExchange = async (_req: Request, res: Response) => {
  try {
    const exchanges = await getCollectionValues("doneExchange");
    res.json(exchanges);
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Failed to fetch completed exchanges" });
  }
};

export const createExchangeInternal = async (req: Request, res: Response) => {
  try {
    const id = req.body?.id || uuidv4();
    const exchange: ExchangeRecord = {
      ...req.body,
      id,
      date: req.body?.date || new Date().toISOString(),
    };

    await set(ref(database, `exchange/${id}`), exchange);
    res.status(201).json(exchange);
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Failed to create exchange" });
  }
};

export const endExchange = async (req: Request, res: Response) => {
  try {
    const { exchangeData, realRate, amount_final, id } = req.body || {};
    const exchangeId = id || exchangeData?.id;

    if (!exchangeId || !exchangeData) {
      return res.status(400).json({ message: "Exchange data is required" });
    }

    const finalAmount = Number(amount_final || 0);
    const finalRate = Number(realRate || 0);
    const expectedAmount = Number(exchangeData.amount_to || 0);
    const completedExchange = {
      ...exchangeData,
      id: exchangeId,
      amount_final: finalAmount,
      finalRate,
      exchangeDifference: finalAmount - expectedAmount,
      completedDate: new Date().toISOString(),
    };

    await set(ref(database, `doneExchange/${exchangeId}`), completedExchange);
    await remove(ref(database, `exchange/${exchangeId}`));

    res.json({
      message: "Exchange completed",
      data: completedExchange,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Failed to complete exchange" });
  }
};
