import { Request } from "express";
import { canPerform, Action } from "./authorization";
import { requireCurrentUser } from "../utils/currentUser";

export const pickFields = (value: any, fields: readonly string[]) =>
  Object.fromEntries(
    fields
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
export const customerLookupFields = [
  "id",
  "name",
  "number",
  "defaultPaymentAccountId",
  "defaultReceivableAccountId",
  "defaultSalesAccountId",
];
export const supplierLookupFields = [
  "id",
  "name",
  "number",
  "defaultPaymentAccountId",
  "defaultPayableAccountId",
  "defaultInventoryAccountId",
];
export const accountLookupFields = [
  "id",
  "name",
  "code",
  "type",
  "category",
  "currency",
  "nature",
  "parentId",
  "isActive",
  "allowTransactions",
];
export const canReadFull = (req: Request, action: Action) =>
  canPerform(requireCurrentUser(req), action);
export const listView = (
  req: Request,
  action: Action,
  values: any[],
  fields: readonly string[],
) =>
  canReadFull(req, action)
    ? values
    : values.map((value) => pickFields(value, fields));
