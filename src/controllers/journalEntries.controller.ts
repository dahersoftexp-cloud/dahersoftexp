import { Request, Response } from "express";
import { get, ref, set } from "../utils/tenantFirebase";
import { v4 as uuidv4 } from "uuid";
import { database } from "../firebaseConfig";
import { Account } from "../types/account";
import { JournalEntry, JournalEntryLine } from "../types/journalEntry";

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
    accountName:
      line.accountName || accountsMap[line.accountId]?.name || line.accountId,
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

  const accountsMap = await getAccountsMap();
  const lines = normalizeLines(journalEntry.lines as JournalEntryLine[], accountsMap);

  const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);

  if (totalDebit !== totalCredit) {
    throw new Error("القيد غير متوازن: مجموع المدين لا يساوي مجموع الدائن");
  }

  const id = uuidv4();
  const entryToSave: JournalEntry = {
    id,
    date: journalEntry.date || new Date().toISOString(),
    description: journalEntry.description.trim(),
    referenceType: journalEntry.referenceType || "",
    referenceId: journalEntry.referenceId || "",
    createdBy: journalEntry.createdBy || "",
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

    const entryToSave = await createJournalEntryInternal(journalEntry);

    return res.status(201).json(entryToSave);
  } catch (error: any) {
    console.error("Error creating journal entry:", error);
    return res.status(500).json({ error: "فشل في إنشاء القيد اليومي" });
  }
};
