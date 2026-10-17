import { Account } from "../types/account";
import { ref, runTransaction } from "./tenantFirebase";

type DefaultAccount = Omit<Account, "createdAt" | "updatedAt">;

const zeroBalances = {
  openingBalance: 0,
  currentBalance: 0,
  openingBalanceUSD: 0,
  openingBalanceSYP: 0,
  currentBalanceUSD: 0,
  currentBalanceSYP: 0,
};

export const defaultAccounts: DefaultAccount[] = [
  {
    id: "default-cash",
    name: "الصندوق",
    code: "1000",
    type: "Asset",
    category: "Cash",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-bank",
    name: "البنك",
    code: "1010",
    type: "Asset",
    category: "Bank",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-accounts-receivable",
    name: "الذمم المدينة",
    code: "1100",
    type: "Asset",
    category: "AccountsReceivable",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-inventory",
    name: "المخزون",
    code: "1200",
    type: "Asset",
    category: "Inventory",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-fixed-assets",
    name: "الأصول الثابتة",
    code: "1500",
    type: "Asset",
    category: "FixedAssets",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-accounts-payable",
    name: "الذمم الدائنة",
    code: "2000",
    type: "Liability",
    category: "AccountsPayable",
    parentId: null,
    nature: "Credit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-equity",
    name: "رأس المال",
    code: "3000",
    type: "Equity",
    category: "Equity",
    parentId: null,
    nature: "Credit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-sales-revenue",
    name: "إيرادات المبيعات",
    code: "4000",
    type: "Revenue",
    category: "SalesRevenue",
    parentId: null,
    nature: "Credit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-cost-of-goods-sold",
    name: "تكلفة البضاعة المباعة",
    code: "5000",
    type: "Expense",
    category: "CostOfGoodsSold",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
  {
    id: "default-operating-expenses",
    name: "المصاريف التشغيلية",
    code: "6000",
    type: "Expense",
    category: "OperatingExpense",
    parentId: null,
    nature: "Debit",
    ...zeroBalances,
    currency: "USD",
    description: "",
    isActive: true,
    isSystem: true,
    allowTransactions: true,
  },
];

export const buildDefaultAccounts = (timestamp = new Date().toISOString()) =>
  Object.fromEntries(
    defaultAccounts.map((account) => [
      account.id,
      {
        ...account,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]),
  ) as Record<string, Account>;

/** Explicit bootstrap only: add missing defaults, preserving all existing fields. */
export const initializeMissingDefaultAccounts = async () => {
  const defaults = buildDefaultAccounts();
  let created: string[] = [];
  await runTransaction(ref("accounts"), (current) => {
    created = []; // Firebase can retry this callback.
    if (
      current !== null &&
      (typeof current !== "object" || Array.isArray(current))
    )
      throw new Error("INVALID_ACCOUNTS_STORE");
    const next: Record<string, Account> = { ...(current || {}) };
    for (const account of Object.values(defaults)) {
      if (
        next[account.id] !== undefined ||
        Object.values(next).some(
          (existing) => String(existing?.code || "") === account.code,
        )
      )
        continue;
      next[account.id] = account;
      created.push(account.id);
    }
    return created.length ? next : undefined;
  });
  return created;
};
