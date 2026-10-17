const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const project = "demo-dahersoft-warehouse";

function getEmulatorInvocation(environment, configuration) {
  if (
    !configuration ||
    Object.keys(configuration).some(
      (key) => !["database", "emulators"].includes(key),
    ) ||
    configuration.database?.rules !== "tests/emulator/database.rules.json" ||
    configuration.emulators?.database?.host !== "127.0.0.1" ||
    configuration.emulators?.database?.port !== 19000 ||
    configuration.emulators?.ui?.enabled !== false ||
    configuration.emulators?.singleProjectMode !== true ||
    Object.keys(configuration.emulators).some(
      (key) => !["database", "ui", "singleProjectMode"].includes(key),
    )
  )
    throw new Error("INVALID_WAREHOUSE_EMULATOR_CONFIGURATION");

  // Pass the operating-system environment needed by Node/Java and npm only.
  // Server credentials, runtime Firebase destinations and agent debug flags
  // stay outside the emulator process and its CLI logs.
  const allowed = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
  ]);
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        allowed.has(key.toUpperCase()) && typeof value === "string",
    ),
  );
  Object.assign(childEnvironment, {
    NODE_ENV: "test",
    CI: "true",
    FIREBASE_CLI_DISABLE_USAGE_REPORTING: "true",
  });
  const javaHome =
    environment.DAHERSOFT_TEST_JAVA_HOME || environment.JAVA_HOME;
  if (javaHome) {
    childEnvironment.JAVA_HOME = javaHome;
    const inheritedPath = Object.entries(childEnvironment).find(
      ([key]) => key.toUpperCase() === "PATH",
    );
    if (inheritedPath) delete childEnvironment[inheritedPath[0]];
    childEnvironment.PATH =
      path.join(javaHome, "bin") + path.delimiter + (inheritedPath?.[1] || "");
  }
  const cache =
    environment.DAHERSOFT_TEST_EMULATOR_CACHE ||
    environment.FIREBASE_EMULATORS_PATH;
  if (cache) childEnvironment.FIREBASE_EMULATORS_PATH = cache;
  const npmCli =
    environment.npm_execpath ||
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
  return {
    command: process.execPath,
    args: [
      npmCli,
      "exec",
      "--yes",
      ...(environment.DAHERSOFT_EMULATOR_OFFLINE === "1" ? ["--offline"] : []),
      "--package=firebase-tools@15.34.0",
      "--",
      "firebase",
      "emulators:exec",
      "--only",
      "database",
      "--config",
      "firebase.emulator.json",
      "--project",
      project,
      "npm run test:warehouse:emulator",
    ],
    environment: childEnvironment,
  };
}

function main(args) {
  if (args.length) throw new Error("WAREHOUSE_EMULATOR_ARGUMENTS_DISABLED");
  const configuration = JSON.parse(
    fs.readFileSync(path.join(root, "firebase.emulator.json"), "utf8"),
  );
  const invocation = getEmulatorInvocation(process.env, configuration);
  if (!fs.existsSync(invocation.args[0])) throw new Error("NPM_CLI_NOT_FOUND");
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env: invocation.environment,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  child.on("error", () => {
    console.error("Could not start warehouse emulator tooling.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error(
      "Warehouse emulator refused invalid configuration or arguments. Use npm run emulators:warehouse with Java 21 available.",
    );
    process.exitCode = 1;
  }
}
module.exports = { getEmulatorInvocation };
