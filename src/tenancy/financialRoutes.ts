import type { Response, RequestHandler, Router } from "express";
import { requireCurrentUser } from "../utils/currentUser";
import { FinancialError, runFinancialCommand } from "./financialUnit";

class RejectedResponse extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super("FINANCIAL_COMMAND_REJECTED");
  }
}
export const financialHandler =
  (handler: RequestHandler): RequestHandler =>
  async (req, res) => {
    try {
      const user = requireCurrentUser(req);
      const result = await runFinancialCommand(
        {
          key: req.get("Idempotency-Key") || "",
          kind: `${req.method}:${req.baseUrl}${req.route.path}`,
          actorId: user.userId,
          body: { params: req.params, body: req.body || {} },
        },
        async () => {
          let status = 200;
          let body: unknown;
          let completed = false;
          const capture: any = {
            status: (code: number) => {
              status = code;
              return capture;
            },
            json: (value: unknown) => {
              completed = true;
              body = value;
              return capture;
            },
            send: (value: unknown) => {
              completed = true;
              body = value;
              return capture;
            },
          };
          await handler(req, capture as Response, (error?: any) => {
            throw error || new Error("UNSUPPORTED_FINANCIAL_NEXT");
          });
          if (!completed) throw new Error("FINANCIAL_RESPONSE_MISSING");
          if (status >= 400) throw new RejectedResponse(status, body);
          return { status, body };
        },
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof RejectedResponse) {
        res.status(error.status).json(error.body);
        return;
      }
      if (error instanceof FinancialError) {
        res
          .status(error.status)
          .json({ error: error.code, message: error.code });
        return;
      }
      res
        .status(503)
        .json({
          error: "FINANCIAL_RESULT_UNCONFIRMED",
          message:
            "تعذر تأكيد نتيجة العملية. أعد المحاولة باستخدام مفتاح العملية نفسه.",
        });
    }
  };
/** Called before mounting routers; read-only POST queries remain unwrapped. */
export const protectFinancialRouter = (router: Router, namespace: string) => {
  for (const layer of (router as any).stack) {
    const route = layer.route;
    if (!route || route.methods.get) continue;
    const path = String(route.path);
    if (["/byId", "/byWarehouseDate", "/getByWarehouse"].includes(path))
      continue;
    if (namespace === "vehicles" && !["/me/sell", "/:id/load"].includes(path))
      continue;
    for (const handler of route.stack)
      handler.handle = financialHandler(handler.handle);
  }
};
