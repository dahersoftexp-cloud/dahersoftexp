import { CurrentUser, getUserFromToken } from "../utils/currentUser";
import {
  DEFAULT_TENANT_ID,
  LEGACY_ROOT_TENANT_ID,
  validateTenantId,
} from "../utils/tenantContext";
import {
  AuthError,
  findAccount,
  isUserKey,
  principalFor,
  readObject,
} from "./accounts";
import { isValidPasswordInput, verifyPassword } from "./passwords";

export async function assertCompanyActive(tenantId: string) {
  const records = await Promise.all([
    readObject(`control/companies/${tenantId}`),
    readObject(`trialTenants/${tenantId}`),
  ]);
  for (const company of records) {
    if (!company) continue;
    if (company.status !== undefined && company.status !== "active")
      throw new AuthError(403, "COMPANY_INACTIVE");
    if (company.expiresAt !== undefined) {
      const expiry = Date.parse(company.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now())
        throw new AuthError(403, "COMPANY_EXPIRED");
    }
  }
}
export function parseCompanyCode(value: unknown) {
  if (value === undefined || value === "") return DEFAULT_TENANT_ID;
  if (typeof value !== "string")
    throw new AuthError(400, "INVALID_COMPANY_CODE");
  try {
    return validateTenantId(value.trim().toLowerCase());
  } catch {
    throw new AuthError(400, "INVALID_COMPANY_CODE");
  }
}
export async function authenticateCredentials(
  username: unknown,
  password: unknown,
  companyCode: unknown,
): Promise<CurrentUser> {
  if (!isUserKey(username) || !isValidPasswordInput(password))
    throw new AuthError(400, "INVALID_LOGIN_INPUT");
  const tenantId = parseCompanyCode(companyCode);
  const account = await findAccount(tenantId, username);
  if (account?.central && typeof account.identity.passwordHash !== "string")
    throw new AuthError(401, "INVALID_CREDENTIALS");
  if (!account || !(await verifyPassword(password, account.identity)))
    throw new AuthError(401, "INVALID_CREDENTIALS");
  const principal = principalFor(account);
  await assertCompanyActive(tenantId);
  return principal;
}
export async function resolveSession(token: string): Promise<CurrentUser> {
  const identity = getUserFromToken(token);
  if (!identity) throw new AuthError(401, "INVALID_SESSION");
  let tenantId: string;
  try {
    tenantId = identity.tenantId
      ? validateTenantId(identity.tenantId)
      : LEGACY_ROOT_TENANT_ID;
  } catch {
    throw new AuthError(401, "INVALID_SESSION");
  }
  const source = !identity.tenantId ? "legacy-root" : identity.source;
  const account = await findAccount(tenantId, identity.userId, source);
  if (!account) throw new AuthError(401, "INVALID_SESSION");
  const principal = principalFor(account);
  if (
    (identity.identityId && identity.identityId !== principal.identityId) ||
    (identity.sessionVersion || "legacy") !== principal.sessionVersion ||
    (account.central && !identity.identityId)
  )
    throw new AuthError(401, "INVALID_SESSION");
  await assertCompanyActive(tenantId);
  return principal;
}
