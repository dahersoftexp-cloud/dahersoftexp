import { Request, Response } from "express";
import { get, ref, set } from "../utils/tenantFirebase";
import { v4 as uuidv4 } from "uuid";
import { database } from "../firebaseConfig";
import { Account } from "../types/account";
import { JournalEntry, JournalEntryLine } from "../types/journalEntry";
import { updateAccountBalanceInternal } from "./account.controller";
import { financialActor } from "../tenancy/financialUnit";

const getAccountsMap = async () => {
  const snapshot = await get(ref(database, "accounts"));
  const accounts = snapshot.exists() ? snapshot.val() : {};

  return accounts as Record<string, Account>;
};

const normalizeLines = (
  lines: JournalEntryLine[],
  accountsMap: Record<string, Account>
): JournalEntryLine[] => {
  return lines.map((line) => ({
    ...line,
    debit: Number(line.debit || 0),
    credit: Number(line.credit || 0),
    accountName: accountsMap[line.accountId]?.name || line.accountId,
  }));
};

export const createJournalEntryInternal = async (
  journalEntry: Partial<JournalEntry>
): Promise<JournalEntry> => {
  if (!journalEntry.description?.trim()) {
    throw new Error("وصف القيد مطلوب");
  }

  if (!Array.isArray(journalEntry.lines) || journalEntry.lines.length === 0) {
    throw new Error("سطور القيد مطلوبة");
  }

  const date = journalEntry.date || new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date.slice(0, 10)).toISOString().slice(0, 10) !== date.slice(0, 10))
    throw new Error("تاريخ القيد غير صالح؛ استخدم تاريخ ISO");

  const accountsMap = await getAccountsMap();
  const lines = normalizeLines(journalEntry.lines as JournalEntryLine[], accountsMap);

  if (lines.length < 2) throw new Error("القيد يحتاج إلى طرفين على الأقل");
  for (const line of lines) {
    const account = accountsMap[line.accountId];
    if (!account || account.isActive === false || account.allowTransactions === false)
      throw new Error("الحساب غير موجود أو لا يسمح بالترحيل");
    if (![line.debit, line.credit].every(Number.isFinite) || line.debit < 0 || line.credit < 0 ||
        (line.debit > 0 && line.credit > 0) || (line.debit === 0 && line.credit === 0))
      throw new Error("كل سطر يجب أن يحتوي مبلغاً موجباً في المدين أو الدائن");
    for (const amount of [line.debit, line.credit]) {
      if (!Number.isSafeInteger(Math.round(amount * 1000)) || Math.abs(amount * 1000 - Math.round(amount * 1000)) > 0.00001)
        throw new Error("المبالغ تدعم ثلاث منازل عشرية ضمن الحد الآمن");
    }
    if (line.currency && !["USD", "SYP"].includes(line.currency)) throw new Error("العملة غير مدعومة");
    if (line.currency === "SYP" && (!Number.isFinite(line.exchangeRate) || Number(line.exchangeRate) <= 0))
      throw new Error("سعر صرف صالح مطلوب");
  }

  const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);

  if (Math.round(totalDebit * 1000) !== Math.round(totalCredit * 1000) || totalDebit <= 0) {
    throw new Error("القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن");
  }

  const id = uuidv4();
  const entryToSave: JournalEntry = {
    id,
    date,
    description: journalEntry.description.trim(),
    referenceType: journalEntry.referenceType || "",
    referenceId: journalEntry.referenceId || "",
    createdBy: financialActor(),
    lines,
  };

  await set(ref(database, `journalEntries/${id}`), entryToSave);

  return entryToSave;
};

export const getJournalEntries = async (_req: Request, res: Response) => {
  try {
    const [entriesSnapshot, accountsMap] = await Promise.all([
      get(ref(database, "journalEntries")),
      getAccountsMap(),
    ]);

    const entries = entriesSnapshot.exists()
      ? (Object.values(entriesSnapshot.val()) as JournalEntry[])
      : [];

    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      lines: normalizeLines(entry.lines || [], accountsMap),
    }));

    return res.status(200).json(normalizedEntries);
  } catch (error: any) {
    console.error("Error fetching journal entries:", error);
    return res.status(500).json({ error: "فشل في جلب القيود اليومية" });
  }
};

export const createJournalEntry = async (req: Request, res: Response) => {
  try {
    const { journalEntry } = req.body as { journalEntry?: Partial<JournalEntry> };
    if (!journalEntry) {
      return res.status(400).json({ error: "بيانات القيد مطلوبة" });
    }

    const entryToSave = await createJournalEntryInternal({
      ...journalEntry, referenceType: "manual", referenceId: "",
      lines: journalEntry.lines?.map(line => ({
        ...line,
        amountUSD: Number(line.debit || line.credit),
        amountSYP: line.currency === "SYP" ? Math.round(Number(line.debit || line.credit) * Number(line.exchangeRate) * 1000) / 1000 : 0,
        amountOriginal: line.currency === "SYP" ? Math.round(Number(line.debit || line.credit) * Number(line.exchangeRate) * 1000) / 1000 : Number(line.debit || line.credit),
      })),
    });
    for (const line of entryToSave.lines) {
      await updateAccountBalanceInternal({
        accountId: line.accountId,
        entryType: line.debit > 0 ? "debit" : "credit",
        amount: line.debit || line.credit,
        currency: line.currency || "USD",
        exchangeRate: line.exchangeRate,
        amountOriginal: line.amountOriginal,
        amountSYP: line.currency === "SYP" ? (line.amountSYP ?? (line.debit || line.credit) * Number(line.exchangeRate)) : 0,
      });
    }

    return res.status(201).json(entryToSave);
  } catch (error: any) {
    console.error("Error creating journal entry:", error);
    return res.status(400).json({ error: error.message || "فشل في إنشاء القيد اليومي" });
  }
};
