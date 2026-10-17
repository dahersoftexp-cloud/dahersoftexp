const assert = require("node:assert/strict");
const { test, before, beforeEach, after } = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const {
  createServerDatabaseReader,
  createServerDatabaseClient,
} = require("../dist/infrastructure/serverDatabase");
const {
  getServerDatabaseConfiguration,
  validateDatabaseUrl,
} = require("../dist/config/serverDatabase");

let baseUrl;
let requests = [];
let reply;
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers });
  reply(req, res);
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  requests = [];
  reply = (_req, res) => json(res, { status: "active" });
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const reader = (options = {}) =>
  createServerDatabaseReader({ baseUrl, allowLoopback: true, ...options });

test("REST reads hit the server again and send credentials only in an authorization header", async () => {
  const read = reader({
    getAccessToken: async () => "synthetic-private-token",
  });
  assert.deepEqual(await read("control/identities/person"), {
    status: "active",
  });
  reply = (_req, res) => json(res, { status: "revoked" });
  assert.deepEqual(await read("control/identities/person"), {
    status: "revoked",
  });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "/control/identities/person.json");
    assert.equal(
      request.headers.authorization,
      "Bearer synthetic-private-token",
    );
    assert.match(request.headers["cache-control"], /no-store/);
    assert.doesNotMatch(request.url, /token|access_token|auth=/);
  }
});

test("an actual connection failure cannot return an earlier successful value", async () => {
  const read = reader();
  await read("users/person");
  reply = (req) => req.socket.destroy();
  await assert.rejects(read("users/person"), {
    code: "SERVER_DATABASE_UNAVAILABLE",
  });
});

test("HTTP permission errors, redirects and cache responses fail closed without exposing response bodies", async () => {
  for (const status of [401, 403, 500, 503, 304]) {
    reply = (_req, res) =>
      json(res, { error: "PRIVATE-REMOTE-DIAGNOSTIC" }, status);
    await assert.rejects(reader()("users/person"), (error) => {
      assert.equal(error.code, "SERVER_DATABASE_UNAVAILABLE");
      assert.doesNotMatch(String(error), /PRIVATE-|127\.0\.0\.1/);
      return true;
    });
  }
  reply = (_req, res) => {
    res.writeHead(302, {
      Location: "https://must-never-be-contacted.invalid/",
    });
    res.end();
  };
  await assert.rejects(reader()("users/person"), {
    code: "SERVER_DATABASE_UNAVAILABLE",
  });
});

test("the deadline covers a stalled connection, a stalled body and credential acquisition", async () => {
  reply = () => {};
  await assert.rejects(reader({ timeoutMs: 80 })("users/person"), {
    code: "SERVER_DATABASE_UNAVAILABLE",
  });
  reply = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"status":');
  };
  await assert.rejects(reader({ timeoutMs: 80 })("users/person"), {
    code: "SERVER_DATABASE_UNAVAILABLE",
  });
  const count = requests.length;
  await assert.rejects(
    reader({ timeoutMs: 80, getAccessToken: () => new Promise(() => {}) })(
      "users/person",
    ),
    { code: "SERVER_DATABASE_UNAVAILABLE" },
  );
  assert.equal(requests.length, count);
});

test("invalid JSON and oversized fixed or streamed replies are rejected", async () => {
  reply = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not-json");
  };
  await assert.rejects(reader()("users/person"), {
    code: "INVALID_SERVER_DATABASE_RESPONSE",
  });
  reply = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('{"status":"active"}');
  };
  await assert.rejects(reader()("users/person"), {
    code: "INVALID_SERVER_DATABASE_RESPONSE",
  });
  reply = (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": 1024,
    });
    res.end("x".repeat(1024));
  };
  await assert.rejects(reader({ maxResponseBytes: 32 })("users/person"), {
    code: "SERVER_DATABASE_RESPONSE_TOO_LARGE",
  });
  reply = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("x".repeat(64));
    res.end();
  };
  await assert.rejects(reader({ maxResponseBytes: 32 })("users/person"), {
    code: "SERVER_DATABASE_RESPONSE_TOO_LARGE",
  });
});

test("missing or failed credentials never retry anonymously", async () => {
  for (const getAccessToken of [
    async () => "",
    async () => {
      throw new Error("PRIVATE-CREDENTIAL-DIAGNOSTIC");
    },
  ]) {
    await assert.rejects(
      reader({ getAccessToken })("users/person"),
      (error) => {
        assert.equal(error.code, "SERVER_DATABASE_UNAVAILABLE");
        assert.doesNotMatch(String(error), /PRIVATE-/);
        return true;
      },
    );
  }
  assert.equal(requests.length, 0);
});

test("paths cannot address the root or escape a key; Arabic and literal percent keys round-trip", async () => {
  const read = reader();
  for (const target of [
    "",
    "/users",
    "users/",
    "users//person",
    "../users",
    "users/a.b",
    "users/a#b",
    "users/a\\b",
    "users/\u0000",
    "users/" + "ض".repeat(385),
  ])
    await assert.rejects(read(target), /INVALID_DATABASE_PATH/);
  assert.equal(requests.length, 0);
  await read("tenants/qa-a/warehouses/مستودع %2F");
  assert.equal(requests.length, 1);
  assert.equal(
    decodeURIComponent(requests[0].url),
    "/tenants/qa-a/warehouses/مستودع %2F.json",
  );
  assert.ok(requests[0].url.includes("%252F"));
});

test("runtime routing only accepts a server-configured Firebase origin and authenticated production mode", () => {
  const origin =
    "https://synthetic-default-rtdb.europe-west1.firebasedatabase.app";
  assert.deepEqual(
    getServerDatabaseConfiguration({
      NODE_ENV: "production",
      FIREBASE_databaseURL: origin,
    }),
    { baseUrl: origin, authMode: "google" },
  );
  assert.equal(
    getServerDatabaseConfiguration({
      NODE_ENV: "development",
      FIREBASE_databaseURL: origin,
    }).authMode,
    "anonymous",
  );
  assert.throws(
    () =>
      getServerDatabaseConfiguration({
        NODE_ENV: "production",
        FIREBASE_databaseURL: origin,
        FIREBASE_REST_AUTH_MODE: "anonymous",
      }),
    /require Google credentials/,
  );
  for (const value of [
    "",
    "http://fixture.firebaseio.com",
    "https://fixture.firebaseio.com.evil.invalid",
    "https://fixture.firebaseio.com/users",
    "https://fixture.firebaseio.com?auth=PRIVATE",
    "https://user:PRIVATE@fixture.firebaseio.com",
    "https://fixture.firebaseio.com:444",
    "http://127.0.0.1:9000",
  ])
    assert.throws(
      () => validateDatabaseUrl(value),
      /INVALID_SERVER_DATABASE_URL/,
    );
  assert.throws(
    () => createServerDatabaseReader({ baseUrl: "http://127.0.0.1:9000" }),
    /INVALID_SERVER_DATABASE_URL/,
  );
});

test("conditional writes use the server's ETag, preserve priorities and authenticate without query credentials", async () => {
  reply = (req, res) => {
    if (req.method === "GET") {
      assert.match(req.url, /format=export/);
      assert.equal(req.headers["x-firebase-etag"], "true");
      res.writeHead(200, {
        "Content-Type": "application/json",
        ETag: '"fixture-etag"',
      });
      res.end(
        JSON.stringify({
          name: { ".value": "Original", ".priority": 5 },
          ".priority": 0,
        }),
      );
      return;
    }
    assert.equal(req.method, "PUT");
    assert.equal(req.headers["if-match"], '"fixture-etag"');
    assert.equal(req.headers.authorization, "Bearer synthetic-write-token");
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      assert.deepEqual(JSON.parse(text), {
        name: { ".value": "Original", ".priority": 5 },
        ".priority": 0,
        location: "New",
      });
      // Receiving a successful status confirms the write; do not wait for an echo body.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    });
  };
  const client = createServerDatabaseClient({
    baseUrl,
    allowLoopback: true,
    getAccessToken: async () => "synthetic-write-token",
  });
  const revision = await client.readVersioned("warehouses/fixture");
  assert.deepEqual(revision.value, { name: "Original" });
  assert.equal(
    await client.compareAndSet("warehouses/fixture", revision, {
      name: "Original",
      location: "New",
    }),
    true,
  );
  assert.ok(
    requests.every((entry) => !entry.url.includes("synthetic-write-token")),
  );
});

test("a revision is bound to its client and path and invalid payloads never reach PUT", async () => {
  reply = (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: '"fixture-etag"',
    });
    res.end("null");
  };
  const client = createServerDatabaseClient({ baseUrl, allowLoopback: true });
  const revision = await client.readVersioned("warehouses/fixture");
  await assert.rejects(
    client.compareAndSet("warehouses/other", revision, {}),
    /INVALID_SERVER_DATABASE_REVISION/,
  );
  await assert.rejects(
    client.compareAndSet("warehouses/fixture", { ...revision }, {}),
    /INVALID_SERVER_DATABASE_REVISION/,
  );
  for (const value of [
    { number: NaN },
    { missing: undefined },
    { "bad/key": true },
    new Date(),
  ])
    await assert.rejects(
      client.compareAndSet("warehouses/fixture", revision, value),
      /INVALID_DATABASE_VALUE/,
    );
  assert.equal(requests.length, 1);
});

test("credential failure before dispatch is not an ambiguous write and does not fall back anonymously", async () => {
  reply = (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: '"fixture-etag"',
    });
    res.end("null");
  };
  let tokenAvailable = true;
  const client = createServerDatabaseClient({
    baseUrl,
    allowLoopback: true,
    getAccessToken: async () => {
      if (!tokenAvailable) throw new Error("PRIVATE-CREDENTIAL-ERROR");
      return "synthetic-token";
    },
  });
  const revision = await client.readVersioned("warehouses/fixture");
  tokenAvailable = false;
  await assert.rejects(
    client.compareAndSet("warehouses/fixture", revision, { name: "New" }),
    { code: "SERVER_DATABASE_UNAVAILABLE" },
  );
  assert.equal(requests.length, 1);
});

test("a timed-out dispatched write is reported as unknown without a second request", async () => {
  reply = (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        ETag: '"fixture-etag"',
      });
      res.end("null");
    }
  };
  const client = createServerDatabaseClient({
    baseUrl,
    allowLoopback: true,
    timeoutMs: 80,
  });
  const revision = await client.readVersioned("warehouses/fixture");
  await assert.rejects(
    client.compareAndSet("warehouses/fixture", revision, { name: "New" }),
    { code: "SERVER_DATABASE_WRITE_OUTCOME_UNKNOWN" },
  );
  assert.equal(requests.filter((entry) => entry.headers["if-match"]).length, 1);
});

test("the Google credential adapter shares an in-flight token request and redacts credential failures", async () => {
  const { GoogleAuth } = require("google-auth-library");
  const original = GoogleAuth.prototype.getAccessToken;
  let calls = 0;
  let fail = false;
  GoogleAuth.prototype.getAccessToken = async function () {
    calls++;
    assert.deepEqual(this.scopes, [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/firebase.database",
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    if (fail) throw new Error("PRIVATE-KEY-DIAGNOSTIC");
    return "synthetic-google-token";
  };
  try {
    const {
      getServerAccessToken,
    } = require("../dist/infrastructure/serverCredentials");
    const result = await Promise.all([
      getServerAccessToken(),
      getServerAccessToken(),
    ]);
    assert.deepEqual(result, [
      "synthetic-google-token",
      "synthetic-google-token",
    ]);
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(getServerAccessToken(), {
      message: "SERVER_CREDENTIALS_UNAVAILABLE",
    });
    fail = false;
    assert.equal(await getServerAccessToken(), "synthetic-google-token");
    GoogleAuth.prototype.getAccessToken = () => {
      throw new Error("PRIVATE-SYNCHRONOUS-ERROR");
    };
    await assert.rejects(getServerAccessToken(), {
      message: "SERVER_CREDENTIALS_UNAVAILABLE",
    });
    GoogleAuth.prototype.getAccessToken = async () =>
      "synthetic-recovered-token";
    assert.equal(await getServerAccessToken(), "synthetic-recovered-token");
  } finally {
    GoogleAuth.prototype.getAccessToken = original;
  }
});
