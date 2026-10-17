import { FinancialError } from "./financialUnit";

const units = (value: unknown) => {
  const amount = Number(value ?? 0);
  if (
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(Math.round(amount * 1000))
  )
    throw new FinancialError("INVALID_LEDGER_AMOUNT", 400);
  return Math.round(amount * 1000);
};
/** Check the movement, preserving historical balances without silently repairing them. */
export const assertFinancialIntegrity = (
  before: Record<string, any>,
  after: Record<string, any>,
) => {
  const movements = new Map<string, { usd: number; syp: number }>();
  for (const [id, entry] of Object.entries(before.journalEntries || {})) {
    if (JSON.stringify(entry) !== JSON.stringify(after.journalEntries?.[id]))
      throw new FinancialError("POSTED_JOURNAL_IMMUTABLE");
  }
  for (const [id, raw] of Object.entries(after.journalEntries || {})) {
    if (before.journalEntries?.[id]) continue;
    const entry = raw as any;
    let debit = 0,
      credit = 0;
    for (const line of entry.lines || []) {
      const account = after.accounts?.[line.accountId];
      if (!account) throw new FinancialError("JOURNAL_ACCOUNT_REQUIRED", 400);
      const d = units(line.debit),
        c = units(line.credit);
      debit += d;
      credit += c;
      if (d < 0 || c < 0 || (d === 0) === (c === 0))
        throw new FinancialError("INVALID_JOURNAL_LINE", 400);
      const direction = account.nature === "Debit" ? 1 : -1;
      const movement = movements.get(line.accountId) || { usd: 0, syp: 0 };
      movement.usd += direction * (d - c);
      if (line.currency === "SYP")
        movement.syp += direction * (d > 0 ? 1 : -1) * units(line.amountSYP);
      movements.set(line.accountId, movement);
    }
    if (debit !== credit || debit <= 0)
      throw new FinancialError("UNBALANCED_JOURNAL", 400);
  }
  for (const [id, raw] of Object.entries(before.accounts || {})) {
    if (!after.accounts?.[id])
      throw new FinancialError("ACCOUNT_PHYSICAL_DELETE_DISABLED");
    if ((raw as any).nature !== after.accounts[id].nature)
      throw new FinancialError("ACCOUNT_NATURE_IMMUTABLE");
  }
  for (const [id, raw] of Object.entries(after.accounts || {})) {
    const account = raw as any;
    const old = before.accounts?.[id] || {};
    const movement = movements.get(id) || { usd: 0, syp: 0 };
    const oldUSD = units(old.currentBalanceUSD ?? old.currentBalance);
    const nextUSD = units(account.currentBalanceUSD ?? account.currentBalance);
    if (
      nextUSD - oldUSD !== movement.usd ||
      units(account.currentBalanceSYP) - units(old.currentBalanceSYP) !==
        movement.syp
    )
      throw new FinancialError("LEDGER_JOURNAL_MISMATCH");
  }
};
