const Module = require("node:module");
const path = require("node:path");
const { createHash } = require("node:crypto");

const clone = (value) => (value === undefined ? null : structuredClone(value));

/** Deliberately not a Firebase emulator: no Rules, retries, or network behavior. */
function createMemoryDatabase(initial = {}) {
  let tree = clone(initial);
  let sequence = 0;
  const writes = [];
  const reads = [];
  const serverReads = [];
  const parts = (target) => target.path.split("/").filter(Boolean);
  const ref = (_database, value = "") => ({
    path: value.replace(/^\/+|\/+$/g, ""),
    key: value.split("/").filter(Boolean).at(-1) || null,
  });
  const read = (target) => {
    let value = tree;
    for (const key of parts(target)) value = value?.[key];
    return clone(value);
  };
  const snapshot = (value, key = null) => ({
    key,
    exists: () => value !== null && value !== undefined,
    val: () => clone(value),
    forEach: (callback) => {
      for (const [childKey, child] of Object.entries(value || {})) {
        if (child !== null && callback(snapshot(child, childKey)) === true)
          return true;
      }
      return false;
    },
  });
  const etag = (target) =>
    '"' +
    createHash("sha256")
      .update(JSON.stringify(read(ref(null, target))))
      .digest("hex") +
    '"';
  const write = (target, value) => {
    if (JSON.stringify(value) === undefined)
      throw new Error("Undefined database write");
    const keys = parts(target);
    if (!keys.length) {
      tree = clone(value) || {};
      return;
    }
    let parent = tree;
    for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = clone(value);
  };
  const set = async (target, value) => {
    write(target, value);
    writes.push({ operation: "set", path: target.path });
  };
  const sdk = {
    ref,
    get: async (target) => {
      reads.push(target.path);
      return snapshot(read(target), target.key);
    },
    set,
    update: async (target, patch) => {
      for (const [key, value] of Object.entries(patch))
        write(ref(null, `${target.path}/${key}`), value);
      writes.push({ operation: "update", path: target.path });
    },
    remove: async (target) => set(target, null),
    push: (target, value) => {
      const child = ref(null, `${target.path}/test-${++sequence}`);
      if (value === undefined) return child;
      return set(child, value).then(() => child);
    },
    runTransaction: async (target, updater) => {
      const value = updater(read(target));
      if (value === undefined)
        return { committed: false, snapshot: snapshot(read(target)) };
      await set(target, value);
      return { committed: true, snapshot: snapshot(value) };
    },
  };
  return {
    sdk,
    writes,
    reads,
    serverReads,
    serverRead: async (target) => {
      reads.push(target);
      serverReads.push(target);
      return read(ref(null, target));
    },
    serverReadVersioned: async (target) => {
      reads.push(target);
      serverReads.push(target);
      return { value: read(ref(null, target)), etag: etag(target) };
    },
    serverCompareAndSet: async (target, revision, value) => {
      if (revision.etag !== etag(target)) return false;
      write(ref(null, target), value);
      writes.push({ operation: "server-put", path: target });
      return true;
    },
    dump: () => clone(tree),
    reset: () => {
      tree = clone(initial);
      writes.length = 0;
      reads.length = 0;
      serverReads.length = 0;
      sequence = 0;
    },
  };
}

function loadWithMemoryDatabase(memory, options = {}) {
  const originalLoad = Module._load;
  const configPath = path.resolve(__dirname, "../../dist/firebaseConfig.js");
  const serverDatabasePath = path.resolve(
    __dirname,
    "../../dist/infrastructure/serverDatabase.js",
  );
  Module._load = function (request, parent, isMain) {
    if (request === "firebase/database") return memory.sdk;
    if (Module._resolveFilename(request, parent, isMain) === serverDatabasePath)
      return {
        readServerJson:
          options.serverReader || ((target) => memory.serverRead(target)),
        readServerVersioned:
          options.serverVersionedReader ||
          ((target) => memory.serverReadVersioned(target)),
        compareAndSetServerJson:
          options.serverCompareAndSet ||
          ((target, revision, value) =>
            memory.serverCompareAndSet(target, revision, value)),
      };
    if (Module._resolveFilename(request, parent, isMain) === configPath)
      return { database: {}, app: {} };
    if (
      request.startsWith("firebase/") ||
      request.startsWith("firebase-admin") ||
      request === "google-auth-library"
    ) {
      throw new Error(
        "Real Firebase SDK imports are forbidden in local baseline tests.",
      );
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const tenantContext = require("../../dist/utils/tenantContext");
    const transactions = require("../../dist/functions/transactions");
    const app = require("../../dist/app").default;
    const { generateToken } = require("../../dist/utils/jwt");
    const { configureSocket } = require("../../dist/socket");
    const passwords = require("../../dist/auth/passwords");
    return {
      ...tenantContext,
      transactions,
      app,
      generateToken,
      configureSocket,
      passwords,
      restoreDatabaseMock: () => {
        Module._load = originalLoad;
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }
}

module.exports = { createMemoryDatabase, loadWithMemoryDatabase };
