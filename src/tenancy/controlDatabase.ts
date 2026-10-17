import { ref } from "firebase/database";
export { get as rootGet, update as rootUpdate, runTransaction as rootRunTransaction } from "firebase/database";
import { database } from "../firebaseConfig";
import { normalizeDatabasePath } from "../utils/tenantContext";

// Infrastructure for identity and platform provisioning only. Business
// controllers must use tenantFirebase; CI checks the import boundary.
export const rootRef = (path = "") =>
  ref(database, normalizeDatabasePath(path));
