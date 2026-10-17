const http = require("node:http");
const { createHash } = require("node:crypto");
const {
  decodeFirebaseExport,
} = require("../../dist/infrastructure/firebaseExport");

/** Local protocol stand-in: no Firebase IAM, Rules, SDK cache or network access. */
function createRestDatabaseServer(memory, hooks = {}) {
  const requests = [];
  const read = (target) =>
    target.split("/").reduce((value, key) => value?.[key], memory.dump()) ??
    null;
  const etag = (value) =>
    '"' +
    createHash("sha256").update(JSON.stringify(value)).digest("hex") +
    '"';
  const json = (res, value, status = 200, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local.invalid");
      if (!url.pathname.endsWith(".json")) return json(res, null, 404);
      const target = url.pathname
        .slice(1, -5)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const event = { method: req.method, path: target, headers: req.headers };
      requests.push(event);
      hooks.onRequest?.(event);
      const failure = hooks.failure?.(target, req.method);
      if (failure === true || failure === "before") {
        req.socket.destroy();
        return;
      }
      if (req.method === "GET") {
        const exported = read(target);
        const version = etag(exported);
        await hooks.beforeRead?.(event);
        return json(
          res,
          url.searchParams.get("format") === "export"
            ? exported
            : decodeFirebaseExport(exported),
          200,
          req.headers["x-firebase-etag"] === "true" ? { ETag: version } : {},
        );
      }
      if (req.method !== "PUT") return json(res, null, 405);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      event.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await hooks.beforeWrite?.(event);
      if (hooks.rejectWrites)
        return json(
          res,
          { error: "PRIVATE-REMOTE-WRITE-ERROR" },
          hooks.rejectWrites,
        );
      const current = read(target);
      if (!req.headers["if-match"] || req.headers["if-match"] !== etag(current))
        return json(res, current, 412, { ETag: etag(current) });
      await memory.sdk.set(memory.sdk.ref(null, target), event.body);
      if (failure === "after") {
        req.socket.destroy();
        return;
      }
      return json(res, decodeFirebaseExport(event.body));
    } catch {
      req.socket.destroy();
    }
  });
  return { server, requests, hooks };
}
module.exports = { createRestDatabaseServer };
