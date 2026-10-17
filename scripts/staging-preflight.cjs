// Read-only readiness checks. This script never loads .env or initializes the app.
const fs = require("node:fs");
const {
  validateDatabaseUrl,
  getServerDatabaseConfiguration,
} = require("../dist/config/serverDatabase");
const { assertRuntimeConfiguration } = require("../dist/config/runtime");

class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new PreflightError(code);
};
const objectWithKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const projectId = (value) =>
  typeof value === "string" &&
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value) &&
  !/^(demo-|example-|replace-)/.test(value);

function getStagingTarget(manifest, environment) {
  if (
    !objectWithKeys(manifest, [
      "schemaVersion",
      "purpose",
      "production",
      "staging",
      "tenantsRoot",
      "testTenantId",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== "isolated-staging" ||
    !objectWithKeys(manifest.production, ["projectId", "databaseUrl"]) ||
    !objectWithKeys(manifest.staging, ["projectId", "databaseUrl"]) ||
    !projectId(manifest.production.projectId) ||
    !projectId(manifest.staging.projectId) ||
    typeof manifest.tenantsRoot !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(manifest.tenantsRoot) ||
    [
      "control",
      "users",
      "trialTenants",
      "trialTemplates",
      "tenantAliases",
    ].includes(manifest.tenantsRoot) ||
    typeof manifest.testTenantId !== "string" ||
    !/^qa-staging-[a-z0-9_-]{1,64}$/.test(manifest.testTenantId)
  )
    fail("STAGING_INVALID_MANIFEST");
  let productionUrl, stagingUrl;
  try {
    productionUrl = validateDatabaseUrl(manifest.production.databaseUrl);
    stagingUrl = validateDatabaseUrl(manifest.staging.databaseUrl);
  } catch {
    fail("STAGING_INVALID_DATABASE_URL");
  }
  if (
    productionUrl === stagingUrl ||
    manifest.production.projectId === manifest.staging.projectId
  )
    fail("STAGING_NOT_ISOLATED");
  for (const target of [manifest.production, manifest.staging]) {
    const namespace = new URL(target.databaseUrl).hostname.split(".")[0];
    if (
      namespace !== target.projectId &&
      !namespace.startsWith(target.projectId + "-")
    )
      fail("STAGING_DATABASE_PROJECT_MISMATCH");
  }
  try {
    if (environment.NODE_ENV !== "production") fail("STAGING_RUNTIME_INSECURE");
    assertRuntimeConfiguration(environment);
  } catch {
    fail("STAGING_RUNTIME_INSECURE");
  }
  const runtime = getServerDatabaseConfiguration(environment);
  if (
    environment.FIREBASE_projectId !== manifest.staging.projectId ||
    runtime.baseUrl !== stagingUrl ||
    (environment.TENANTS_ROOT || "tenants") !== manifest.tenantsRoot
  )
    fail("STAGING_RUNTIME_MISMATCH");
  return Object.freeze({
    projectId: manifest.staging.projectId,
    databaseUrl: stagingUrl,
    tenantsRoot: manifest.tenantsRoot,
    testTenantId: manifest.testTenantId,
  });
}

async function probeStagingTarget(target, dependencies = {}) {
  try {
    const createClient =
      dependencies.createClient ||
      require("../dist/infrastructure/serverDatabase")
        .createServerDatabaseClient;
    const client = createClient({
      baseUrl: target.databaseUrl,
      getAccessToken:
        dependencies.getAccessToken ||
        (() =>
          require("../dist/infrastructure/serverCredentials").getServerAccessToken()),
    });
    await Promise.all([
      client.read(`control/companies/${target.testTenantId}`),
      client.readVersioned(
        `${target.tenantsRoot}/${target.testTenantId}/warehouses/__staging_probe__`,
      ),
    ]);
    return { cloudReadChecked: true, versionedReadChecked: true };
  } catch {
    fail("STAGING_READ_PROBE_FAILED");
  }
}

function parseArguments(args) {
  let file,
    probe = false;
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--config" &&
      !file &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      file = args[++i];
    else if (args[i] === "--probe" && !probe) probe = true;
    else fail("STAGING_INVALID_ARGUMENTS");
  }
  if (!file) fail("STAGING_INVALID_ARGUMENTS");
  return { file, probe };
}

async function main(args) {
  const { file, probe } = parseArguments(args);
  const manifest = JSON.parse(
    fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
  );
  const target = getStagingTarget(manifest, process.env);
  const result = probe
    ? await probeStagingTarget(target)
    : { cloudReadChecked: false, versionedReadChecked: false };
  process.stdout.write(
    JSON.stringify(
      {
        reportVersion: 1,
        ...target,
        configurationChecked: true,
        ...result,
        writesPerformed: 0,
        productionReadinessVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof PreflightError ? error.code : "STAGING_PREFLIGHT_FAILED",
    );
    console.error(
      "Use --config <isolated-staging.json> [--probe]. No writes are performed; raw errors and credentials are omitted.",
    );
    process.exitCode = 1;
  });
}
module.exports = { getStagingTarget, probeStagingTarget, parseArguments };
