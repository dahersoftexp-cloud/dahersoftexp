import { AuthError } from "./accounts";

const slots = new Map<
  string,
  { until: number; count: number; busy: boolean }
>();
/** Per-process limit. A shared limiter is required before using multiple nodes. */
export const acquireAiSlot = (tenantId: string) => {
  const now = Date.now();
  for (const [key, value] of slots)
    if (!value.busy && value.until <= now) slots.delete(key);
  const slot = slots.get(tenantId) || {
    until: now + 60_000,
    count: 0,
    busy: false,
  };
  if (slot.busy || slot.count >= 5 || slots.size >= 10_000)
    throw new AuthError(429, "AI_RATE_LIMIT");
  slot.busy = true;
  slot.count++;
  slots.set(tenantId, slot);
  return () => {
    slot.busy = false;
  };
};
