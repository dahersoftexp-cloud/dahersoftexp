import {
  get,
  push,
  ref as firebaseRef,
  remove,
  runTransaction,
  set,
  update,
  type Database,
  type DatabaseReference,
} from "firebase/database";
import { database } from "../firebaseConfig";
import { getTenantDatabasePath, normalizeDatabasePath } from "./tenantContext";

export { database, get, push, remove, runTransaction, set, update };

export const getDatabase = () => database;

export const rootRef = (path = "") => {
  const cleanPath = normalizeDatabasePath(path);
  return cleanPath ? firebaseRef(database, cleanPath) : firebaseRef(database);
};

export const ref = (
  databaseOrPath?: Database | string | null,
  path?: string,
): DatabaseReference => {
  const requestedPath =
    typeof databaseOrPath === "string"
      ? databaseOrPath
      : typeof path === "string"
        ? path
        : "";

  return firebaseRef(database, getTenantDatabasePath(requestedPath));
};
