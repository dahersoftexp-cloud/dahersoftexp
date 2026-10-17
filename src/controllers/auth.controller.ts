import { Request, Response } from "express";
import { generateToken } from "../utils/jwt";
import { authenticateCredentials } from "../auth/session";
import { sendAuthError } from "../auth/middleware";
import { DEFAULT_TENANT_ID } from "../utils/tenantContext";
const attempts = new Map<string, { count: number; until: number }>();

export const login = async (req: Request, res: Response) => {
  const { username, password, companyCode, tenantId } = req.body || {};
  const requestedCompany = companyCode ?? tenantId;
  const key = JSON.stringify([
    req.ip,
    typeof username === "string" ? username.trim().slice(0, 256) : "",
    typeof requestedCompany === "string"
      ? requestedCompany.trim().toLowerCase().slice(0, 128) || DEFAULT_TENANT_ID
      : DEFAULT_TENANT_ID,
  ]);
  const now = Date.now();
  for (const [id, attempt] of attempts)
    if (attempt.until <= now) attempts.delete(id);
  const attempt = attempts.get(key) || { count: 0, until: now + 5 * 60_000 };
  if (attempt.count >= 12 || attempts.size >= 10_000)
    return res.status(429).json({ error: "LOGIN_RATE_LIMIT" });
  attempt.count++;
  attempts.set(key, attempt);
  try {
    const user = await authenticateCredentials(
      typeof username === "string" ? username.trim() : username,
      password,
      companyCode ?? tenantId,
    );
    attempts.delete(key);
    const token = generateToken({
      userId: user.userId,
      username: user.username,
      tenantId: user.tenantId,
      identityId: user.identityId,
      source: user.source,
      sessionVersion: user.sessionVersion,
    });
    return res.json({
      message: "Login successful",
      token,
      user: {
        id: user.userId,
        username: user.username,
        identityId: user.identityId,
        tenantId: user.tenantId,
        companyCode: user.tenantId,
        role: user.role,
        permissions: user.permissions,
        vehicleId: user.vehicleId,
        vehicleName: user.vehicleName,
      },
    });
  } catch (error) {
    return sendAuthError(res, error);
  }
};
