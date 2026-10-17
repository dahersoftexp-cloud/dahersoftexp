const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const serverRoot = path.resolve(__dirname, "..");
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) throw new Error("Source directory does not exist.");
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  }).sort();
}

function scanProject(root) {
  const imports = [];
  const databaseReferences = [];
  const routes = [];
  const mounts = [];
  const files = sourceFiles(path.join(root, "src"));

  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const location = (node) => ({
      file: relative(root, file),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
    const bindings = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      imports.push({ ...location(statement), module: moduleName });
      if (statement.importClause?.name) bindings.set(statement.importClause.name.text, { module: moduleName, name: "default" });
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          bindings.set(item.name.text, { module: moduleName, name: item.propertyName?.text || item.name.text });
        }
      }
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const binding = bindings.get(node.expression.text);
          if (binding && ["ref", "rootRef", "readServerJson", "readServerVersioned", "compareAndSetServerJson"].includes(binding.name)) {
            const serverAccess = ["readServerJson", "readServerVersioned", "compareAndSetServerJson"].includes(binding.name);
            const arg = binding.name === "rootRef" || serverAccess ? node.arguments[0]
              : node.arguments.length > 1 ? node.arguments[1]
              : node.arguments[0] && !ts.isIdentifier(node.arguments[0]) ? node.arguments[0] : undefined;
            databaseReferences.push({
              ...location(node),
              access: serverAccess ? "server-rest"
                : binding.name === "rootRef" ? "control-root"
                : binding.module.includes("tenantFirebase") ? "tenant-wrapper" : "direct-sdk",
              pathExpression: arg ? arg.getText(source) : "<root-or-dynamic>",
              ...(serverAccess ? { operation: binding.name === "compareAndSetServerJson" ? "conditional-write" : "read" } : {}),
            });
          }
        }
        if (ts.isPropertyAccessExpression(node.expression) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const receiver = node.expression.expression.getText(source);
          const method = node.expression.name.text;
          if (["router", "app"].includes(receiver) && ["get", "post", "put", "delete", "patch", "use"].includes(method)) {
            const record = {
              ...location(node), method: method.toUpperCase(), path: node.arguments[0].text,
              handlers: node.arguments.slice(1).map((arg) => ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg) ? arg.getText(source) : "<inline>"),
              authorization: "manual-review-required",
            };
            if (method === "use") {
              const handler = node.arguments[1];
              const binding = handler && ts.isIdentifier(handler) && bindings.get(handler.text);
              const target = binding && binding.module.startsWith(".") ? path.resolve(path.dirname(file), `${binding.module}.ts`) : null;
              mounts.push({ ...record, targetFile: target ? relative(root, target) : null });
            } else routes.push(record);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const apiMounts = mounts.filter((entry) => entry.file === "src/routes/index.ts");
  for (const route of routes) {
    const mount = apiMounts.find((entry) => entry.targetFile === route.file);
    route.apiPath = mount ? `/api${mount.path}${route.path === "/" ? "" : route.path}` : null;
  }
  return { sourceFileCount: files.length, routes, mounts, databaseReferences,
    firebaseImports: imports.filter((entry) => /^firebase(?:-admin)?\//.test(entry.module)),
    serverDatabaseImports: imports.filter((entry) => /(?:infrastructure\/server(?:Database|Credentials)$|^google-auth-library$)/.test(entry.module)),
    note: "Static inventory only. Dynamic references and authorization need review; tenant-wrapper is not proof of trusted identity.",
  };
}

function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== "--frontend")) {
    throw new Error("Usage: node scripts/audit-source.cjs [--frontend ../inventoryDaher]");
  }
  const report = { reportVersion: 1, server: scanProject(serverRoot) };
  if (args[1]) report.frontend = scanProject(path.resolve(process.cwd(), args[1]));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Source inventory failed. Check the source directories and --frontend argument."); process.exitCode = 1; }
}
module.exports = { scanProject };
