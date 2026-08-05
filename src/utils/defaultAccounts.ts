import { Account } from "../types/account";
import { get, ref, update } from "./tenantFirebase";

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

const buildZeroBalancePatch = (updatedAt: string) => ({
  ...zeroBalances,
  updatedAt,
});

export const ensureDefaultAccounts = async (
  options: { resetBalances?: boolean } = {},
) => {
  const accountsSnapshot = await get(ref("accounts"));
  const existingAccounts = accountsSnapshot.exists()
    ? (accountsSnapshot.val() as Record<string, Partial<Account>>)
    : {};
  const existingEntries = Object.entries(existingAccounts);
  const timestamp = new Date().toISOString();
  const updates: Record<string, unknown> = {};

  for (const account of defaultAccounts) {
    const matchingEntry =
      existingAccounts[account.id] !== undefined
        ? ([account.id, existingAccounts[account.id]] as [
            string,
            Partial<Account>,
          ])
        : existingEntries.find(([, existingAccount]) => {
            return String(existingAccount?.code || "") === account.code;
          });

    if (!matchingEntry) {
      updates[`accounts/${account.id}`] = {
        ...account,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      continue;
    }

    const [accountId] = matchingEntry;
    const basePatch: Partial<Account> = {
      id: accountId,
      name: account.name,
      code: account.code,
      type: account.type,
      category: account.category,
      parentId: account.parentId,
      nature: account.nature,
      currency: account.currency,
      description: account.description,
      isActive: true,
      isSystem: true,
      allowTransactions: true,
      updatedAt: timestamp,
    };
    const patch = options.resetBalances
      ? { ...basePatch, ...buildZeroBalancePatch(timestamp) }
      : basePatch;

    Object.entries(patch).forEach(([key, value]) => {
      updates[`accounts/${accountId}/${key}`] = value;
    });
  }

  if (Object.keys(updates).length > 0) {
    await update(ref(), updates);
  }

  return updates;
};
