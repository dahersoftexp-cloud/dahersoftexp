import { Request, Response, NextFunction } from "express";
import { AuthError, readObject } from "./accounts";
import { sendAuthError } from "./middleware";
import { CurrentUser, getCurrentUserFromRequest } from "../utils/currentUser";
import { canManageTenants } from "./platformPermissions";

// Page permissions are the compatibility bridge. Explicit action permissions can
// be assigned independently as the permission editor evolves.
export const actionPages = {
  "products.read": [
    "home",
    "dashboard",
    "products",
    "inventory-balances",
    "purchases",
    "sell-product",
    "quotations",
    "material-reservations",
    "vehicles",
    "warehouses",
    "categories",
    "profit-analysis",
  ],
  "products.write": ["products", "purchases"],
  "products.delete": [],
  "products.prices": [],
  "customers.read": [
    "home",
    "dashboard",
    "customers",
    "financial-statement",
    "profit-analysis",
  ],
  "customers.lookup": [
    "sell-product",
    "driver-sales",
    "quotations",
    "material-reservations",
  ],
  "customers.create": [
    "customers",
    "sell-product",
    "driver-sales",
    "quotations",
    "material-reservations",
  ],
  "customers.write": ["customers"],
  "suppliers.read": ["dashboard", "suppliers", "financial-statement"],
  "suppliers.lookup": ["purchases", "products"],
  "suppliers.create": ["suppliers", "purchases", "products"],
  "suppliers.write": ["suppliers"],
  "purchases.read": ["purchases", "suppliers", "financial-statement"],
  "purchases.create": ["purchases", "products"],
  "sales.read": [
    "home",
    "dashboard",
    "sell-product",
    "customers",
    "financial-statement",
    "income-statement",
    "profit-analysis",
    "warehouses",
  ],
  "sales.create": ["sell-product"],
  "sales.write": ["sell-product"],
  "sales.delete": ["sell-product"],
  "payments.read": [
    "home",
    "dashboard",
    "financial-statement",
    "income-statement",
  ],
  "payments.create": ["financial-statement"],
  "customers.payment": ["customers"],
  "suppliers.payment": ["suppliers"],
  "customers.return": ["customers"],
  "suppliers.return": ["suppliers"],
  "returns.read": ["financial-statement", "customers", "suppliers"],
  "stock.transfer": ["products", "warehouses"],
  "sales.discount": ["customers", "sell-product"],
  "warehouses.read": [
    "products",
    "inventory-balances",
    "purchases",
    "sell-product",
    "quotations",
    "material-reservations",
    "vehicles",
    "warehouses",
    "categories",
  ],
  "warehouses.create": ["warehouses"],
  "warehouses.write": ["warehouses"],
  "warehouses.archive": [],
  "accounts.read": [
    "accounts",
    "journal-entries",
    "trial-balance",
    "general-ledger",
    "income-statement",
  ],
  "accounts.lookup": [
    "products",
    "purchases",
    "sell-product",
    "driver-sales",
    "customers",
    "suppliers",
    "financial-statement",
    "exchange",
    "vehicles",
    "material-reservations",
  ],
  "accounts.write": ["accounts"],
  "journal.read": [
    "journal-entries",
    "trial-balance",
    "general-ledger",
    "income-statement",
  ],
  "journal.create": ["journal-entries"],
  "draft.use": ["sell-product"],
  "exchange.read": ["exchange", "financial-statement"],
  "exchange.create": ["exchange"],
  "reservations.read": ["material-reservations"],
  "reservations.write": ["material-reservations"],
  "quotations.read": ["quotations"],
  "quotations.write": ["quotations"],
  "driver.use": ["driver-sales"],
  "ai.read": [],
  "ai.write": [],
} as const;
export type Action = keyof typeof actionPages;
export const canPerform = (user: CurrentUser, action: Action) =>
  user.role === "admin" ||
  user.permissions.includes(action) ||
  actionPages[action].some((page: string) => user.permissions.includes(page));

type Policy = {
  method: string;
  path: string;
  actions?: Action[];
  admin?: boolean;
  platform?: boolean;
  ai?: boolean;
  retired?: boolean;
  public?: boolean;
};
const policy = (method: string, path: string, actions: Action[]): Policy => ({
  method,
  path,
  actions,
});
export const apiPolicies: Policy[] = [
  { method: "POST", path: "/auth/login", public: true },
  ...["GET", "POST", "PUT", "DELETE"].flatMap((method) => {
    const path = ["PUT", "DELETE"].includes(method) ? "/users/:id" : "/users";
    return [{ method, path, admin: true }];
  }),
  ...["GET", "POST", "DELETE"].map((method) => ({
    method,
    path: method === "DELETE" ? "/trials/:tenantId" : "/trials",
    platform: true,
  })),
  policy("GET", "/products", ["products.read"]),
  policy("POST", "/products/byId", ["products.read"]),
  policy("POST", "/products/getByWarehouse", ["products.read"]),
  policy("POST", "/products", ["products.write"]),
  policy("PUT", "/products/:id", ["products.write"]),
  policy("DELETE", "/products/:id", ["products.delete"]),
  policy("POST", "/products/bulk-update-prices", ["products.prices"]),
  policy("GET", "/customers", ["customers.read", "customers.lookup"]),
  policy("POST", "/customers", ["customers.create"]),
  policy("POST", "/customers/byId", ["customers.read"]),
  policy("PUT", "/customers/:id", ["customers.write"]),
  policy("GET", "/suppliers", ["suppliers.read", "suppliers.lookup"]),
  policy("POST", "/suppliers", ["suppliers.create"]),
  policy("POST", "/suppliers/byId", ["suppliers.read"]),
  policy("PUT", "/suppliers/:id", ["suppliers.write"]),
  policy("GET", "/purchases", ["purchases.read"]),
  policy("POST", "/purchases", ["purchases.create"]),
  policy("POST", "/transactions/purchase", ["purchases.create"]),
  policy("POST", "/transactions/purchase-invoice", ["purchases.create"]),
  policy("POST", "/transactions/sell", ["sales.create"]),
  policy("POST", "/transactions/customerPayment", ["customers.payment"]),
  policy("POST", "/transactions/supplierPayment", ["suppliers.payment"]),
  policy("POST", "/transactions/CustomerReturn", ["customers.return"]),
  policy("POST", "/transactions/SupplierReturn", ["suppliers.return"]),
  policy("POST", "/transactions/warehouseTransfer", ["stock.transfer"]),
  policy("POST", "/transactions/afterSellDiscount", ["sales.discount"]),
  policy("POST", "/transactions/endExchange", ["exchange.create"]),
  policy("GET", "/payments", ["payments.read"]),
  policy("GET", "/payments/month", ["payments.read"]),
  policy("POST", "/payments/create", ["payments.create"]),
  policy("GET", "/sells", ["sales.read"]),
  policy("GET", "/sells/:id", ["sales.read"]),
  policy("PUT", "/sells/:id", ["sales.write"]),
  policy("DELETE", "/sells/:id", ["sales.delete"]),
  policy("POST", "/sells/byWarehouseDate", ["sales.read"]),
  policy("GET", "/warehouses", ["warehouses.read"]),
  policy("POST", "/warehouses", ["warehouses.create"]),
  policy("PUT", "/warehouses/:id", ["warehouses.write"]),
  policy("DELETE", "/warehouses/:id", ["warehouses.archive"]),
  { method: "GET", path: "/warehouses/migrate", retired: true },
  policy("GET", "/account/get-account", ["accounts.read", "accounts.lookup"]),
  policy("GET", "/account/get-account/:id", ["accounts.read"]),
  policy("POST", "/account/create-account", ["accounts.write"]),
  policy("PUT", "/account/update-account/:id", ["accounts.write"]),
  policy("DELETE", "/account/delete-account/:id", ["accounts.write"]),
  { method: "POST", path: "/account/initialize-defaults", admin: true },
  policy("GET", "/journal-entries", ["journal.read"]),
  policy("POST", "/journal-entries/create", ["journal.create"]),
  policy("GET", "/returns", ["returns.read"]),
  policy("GET", "/returns/:id", ["returns.read"]),
  policy("POST", "/returns/byId", ["returns.read"]),
  // The generic endpoint bypasses the accounting return workflows.
  { method: "POST", path: "/returns", admin: true },
  policy("GET", "/invoice-draft/me", ["draft.use"]),
  policy("PUT", "/invoice-draft/me", ["draft.use"]),
  policy("DELETE", "/invoice-draft/me", ["draft.use"]),
  policy("POST", "/invoice-draft/me/checkout", ["sales.create"]),
  policy("GET", "/exchange/getAll", ["exchange.read"]),
  policy("GET", "/doneExchange/getAll", ["exchange.read"]),
  policy("POST", "/exchange/createExchangeInternal", ["exchange.create"]),
  policy("GET", "/material-reservations", ["reservations.read"]),
  policy("GET", "/material-reservations/:id", ["reservations.read"]),
  policy("POST", "/material-reservations", ["reservations.write"]),
  policy("POST", "/material-reservations/:id/close", ["reservations.write"]),
  policy("POST", "/material-reservations/:id/cancel", ["reservations.write"]),
  policy("GET", "/quotations", ["quotations.read"]),
  policy("GET", "/quotations/:id", ["quotations.read"]),
  policy("POST", "/quotations", ["quotations.write"]),
  policy("PUT", "/quotations/:id", ["quotations.write"]),
  policy("DELETE", "/quotations/:id", ["quotations.write"]),
  policy("POST", "/quotations/:id/converted", ["quotations.write"]),
  ...["GET", "POST", "PUT"].map((method) => ({
    method,
    path: method === "PUT" ? "/vehicles/:id" : "/vehicles",
    admin: true,
  })),
  { method: "POST", path: "/vehicles/:id/load", admin: true },
  policy("GET", "/vehicles/me", ["driver.use"]),
  policy("GET", "/vehicles/me/diagnostics", ["driver.use"]),
  policy("POST", "/vehicles/me/sell", ["driver.use"]),
  { method: "GET", path: "/currency-migration/preview", admin: true },
  { method: "POST", path: "/currency-migration/run", admin: true },
  ...["/save", "/snapshot"].map((path) => ({
    ...policy("POST", `/ai${path}`, ["ai.write"]),
    ai: true,
  })),
  ...["/save", "/snapshot/save"].map((path) => ({
    ...policy("PUT", `/ai${path}`, ["ai.write"]),
    ai: true,
  })),
  ...["/latest", "/snapshot/get"].map((path) => ({
    ...policy("GET", `/ai${path}`, ["ai.read"]),
    ai: true,
  })),
  { ...policy("POST", "/ai/ask", ["ai.write"]), ai: true },
  { method: "GET", path: "/ai/allData", retired: true },
];

const compiled = apiPolicies.map((entry) => ({
  ...entry,
  pattern: new RegExp(
    `^${entry.path
      .split("/")
      .map((part) =>
        part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}/?$`,
    "i",
  ),
}));
export const findApiPolicy = (method: string, path: string) =>
  compiled.find(
    (entry) =>
      entry.method === (method === "HEAD" ? "GET" : method) &&
      entry.pattern.test(path),
  );

export const requireApiPermission = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const entry = findApiPolicy(req.method, req.path);
  // New routes require an explicit policy. A missing policy never grants access.
  if (!entry) return res.status(403).json({ error: "API_POLICY_REQUIRED" });
  if (entry.public) return next();
  const user = getCurrentUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "INVALID_SESSION" });
  if (entry.retired) return res.status(410).json({ error: "ENDPOINT_RETIRED" });
  if (
    (entry.admin && user.role !== "admin") ||
    (entry.platform && !canManageTenants(user)) ||
    (entry.actions && !entry.actions.some((action) => canPerform(user, action)))
  )
    return res.status(403).json({ error: "ACTION_FORBIDDEN" });
  try {
    if (entry.ai) {
      const company = await readObject(`control/companies/${user.tenantId}`);
      if (company?.entitlements?.ai !== true)
        throw new AuthError(403, "FEATURE_DISABLED");
    }
    return next();
  } catch (error) {
    return sendAuthError(res, error);
  }
};
