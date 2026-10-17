import {
  getServerDatabaseConfiguration,
  validateDatabaseUrl,
} from "../config/serverDatabase";
import { validateRelativeDatabasePath } from "../tenancy/databasePath";
import {
  decodeFirebaseExport,
  preserveFirebasePriorities,
  validateDatabaseValue,
} from "./firebaseExport";

export class ServerDatabaseError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
type ReaderOptions = {
  baseUrl: string;
  getAccessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  // Only injected local test servers can opt in; the runtime factory never does.
  allowLoopback?: boolean;
};
export interface ServerDatabaseRevision {
  readonly value: unknown;
  readonly etag: string;
}
export const createServerDatabaseClient = (options: ReaderOptions) => {
  const baseUrl = validateDatabaseUrl(options.baseUrl, options.allowLoopback);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new Error("INVALID_SERVER_DATABASE_LIMITS");

  const revisions = new WeakMap<
    ServerDatabaseRevision,
    { path: string; exported: unknown }
  >();
  const request = async (
    path: string,
    settings: { versioned?: boolean; body?: string; etag?: string } = {},
  ): Promise<any> => {
    validateRelativeDatabasePath(path);
    const writing = settings.body !== undefined;
    const endpoint = `${baseUrl}/${path.split("/").map(encodeURIComponent).join("/")}.json${settings.versioned ? "?format=export" : ""}`;
    const controller = new AbortController();
    let dispatched = false;
    let rejected = false;
    const unavailable = () =>
      new ServerDatabaseError(
        writing && dispatched && !rejected
          ? "SERVER_DATABASE_WRITE_OUTCOME_UNKNOWN"
          : "SERVER_DATABASE_UNAVAILABLE",
      );
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(unavailable());
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const accessToken = options.getAccessToken
            ? await options.getAccessToken()
            : undefined;
          controller.signal.throwIfAborted();
          if (
            options.getAccessToken &&
            (!accessToken || typeof accessToken !== "string")
          )
            throw new ServerDatabaseError("SERVER_DATABASE_UNAVAILABLE");
          dispatched = true;
          const response = await (options.fetch || fetch)(endpoint, {
            method: writing ? "PUT" : "GET",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store, no-cache",
              ...(settings.versioned ? { "X-Firebase-ETag": "true" } : {}),
              ...(writing
                ? {
                    "Content-Type": "application/json",
                    "if-match": settings.etag!,
                  }
                : {}),
              ...(accessToken
                ? { Authorization: `Bearer ${accessToken}` }
                : {}),
            },
            ...(writing ? { body: settings.body } : {}),
          });
          if (writing) {
            if (response.status === 200 || response.status === 204) return true;
            if (response.status === 412) {
              rejected = true;
              return false;
            }
            if (
              [400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)
            ) {
              rejected = true;
              throw new ServerDatabaseError("SERVER_DATABASE_WRITE_REJECTED");
            }
            throw unavailable();
          }
          if (response.status !== 200)
            throw new ServerDatabaseError("SERVER_DATABASE_UNAVAILABLE");
          if (
            response.headers.get("content-type")?.split(";")[0].trim() !==
            "application/json"
          )
            throw new ServerDatabaseError("INVALID_SERVER_DATABASE_RESPONSE");
          if (Number(response.headers.get("content-length")) > maxBytes)
            throw new ServerDatabaseError("SERVER_DATABASE_RESPONSE_TOO_LARGE");
          const chunks: Buffer[] = [];
          let received = 0;
          const reader = response.body?.getReader();
          if (!reader)
            throw new ServerDatabaseError("INVALID_SERVER_DATABASE_RESPONSE");
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes)
              throw new ServerDatabaseError(
                "SERVER_DATABASE_RESPONSE_TOO_LARGE",
              );
            chunks.push(Buffer.from(value));
          }
          try {
            const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!settings.versioned) return exported;
            const etag = response.headers.get("etag");
            if (
              !etag ||
              etag.length > 1024 ||
              etag.includes("*") ||
              /[\r\n,]/.test(etag)
            )
              throw new ServerDatabaseError("INVALID_SERVER_DATABASE_REVISION");
            const revision = Object.freeze({
              value: decodeFirebaseExport(exported),
              etag,
            });
            revisions.set(revision, { path, exported });
            return revision;
          } catch (error) {
            if (error instanceof ServerDatabaseError) throw error;
            throw new ServerDatabaseError("INVALID_SERVER_DATABASE_RESPONSE");
          }
        })(),
      ]);
    } catch (error) {
      if (error instanceof ServerDatabaseError) throw error;
      // Never propagate request URLs, credential library errors or response bodies.
      throw unavailable();
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  };
  return Object.freeze({
    read: (path: string): Promise<unknown> => request(path),
    readVersioned: (path: string): Promise<ServerDatabaseRevision> =>
      request(path, { versioned: true }),
    compareAndSet: async (
      path: string,
      revision: ServerDatabaseRevision,
      value: unknown,
    ): Promise<boolean> => {
      const previous = revisions.get(revision);
      if (!previous || previous.path !== path)
        throw new Error("INVALID_SERVER_DATABASE_REVISION");
      validateDatabaseValue(value);
      const body = JSON.stringify(
        preserveFirebasePriorities(previous.exported, value),
      );
      if (Buffer.byteLength(body, "utf8") > maxBytes)
        throw new Error("SERVER_DATABASE_WRITE_TOO_LARGE");
      return request(path, { body, etag: revision.etag });
    },
  });
};

export const createServerDatabaseReader = (options: ReaderOptions) =>
  createServerDatabaseClient(options).read;
let runtimeClient: ReturnType<typeof createServerDatabaseClient> | undefined;
const getRuntimeClient = () => {
  if (!runtimeClient) {
    const configuration = getServerDatabaseConfiguration();
    runtimeClient = createServerDatabaseClient({
      baseUrl: configuration.baseUrl,
      ...(configuration.authMode === "google"
        ? {
            getAccessToken: async () =>
              (await import("./serverCredentials")).getServerAccessToken(),
          }
        : {}),
    });
  }
  return runtimeClient;
};
export const readServerJson = (path: string) => getRuntimeClient().read(path);
export const readServerVersioned = (path: string) =>
  getRuntimeClient().readVersioned(path);
export const compareAndSetServerJson = (
  path: string,
  revision: ServerDatabaseRevision,
  value: unknown,
) => getRuntimeClient().compareAndSet(path, revision, value);
