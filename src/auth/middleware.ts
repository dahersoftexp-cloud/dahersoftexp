import { Request, Response, NextFunction } from "express";
import { AuthError } from "./accounts";
import { resolveSession } from "./session";
import { getRequestToken, setCurrentUserOnRequest } from "../utils/currentUser";
import { runWithTenant } from "../utils/tenantContext";

export const sendAuthError = (res: Response, error: unknown) => {
  if (error instanceof AuthError)
    return res.status(error.status).json({ error: error.code });
  if (error instanceof Error && error.message === "AUTH_BUSY")
    return res.status(503).json({ error: "AUTH_BUSY" });
  return res.status(503).json({ error: "AUTH_UNAVAILABLE" });
};
export const requireTenantSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.method === "POST" && /^\/auth\/login\/?$/i.test(req.path))
    return next();
  try {
    const user = await resolveSession(getRequestToken(req));
    setCurrentUserOnRequest(req, user);
    runWithTenant(user.tenantId, next);
  } catch (error) {
    sendAuthError(res, error);
  }
};
