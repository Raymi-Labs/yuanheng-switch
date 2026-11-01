// Fingerprints contain syntax hashes and identifier names, never vendor source.
const ts = require("typescript");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const printer = ts.createPrinter();
// Global runtime capabilities are not minifier-local names. Never normalize
// a changed global into the baseline's safe implementation during replay.
const globals = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "JSON",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "Reflect",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Buffer",
  "Uint8Array",
  "ArrayBuffer",
  "TextDecoder",
  "TextEncoder",
  "URL",
  "Headers",
  "Response",
  "Request",
  "ReadableStream",
  "AbortController",
  "AbortSignal",
  "DOMException",
  "fetch",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "process",
  "globalThis",
  "require",
  "eval",
  "Function",
  "console",
  "undefined",
  "NaN",
  "Infinity",
  "atob",
  "btoa",
  "parseInt",
  "parseFloat",
  "isNaN",
  "encodeURIComponent",
  "decodeURIComponent",
]);
function propertyName(node) {
  const p = node.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === node) ||
    ((ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
      p.name === node)
  );
}
function fingerprint(node, ast) {
  const names = [];
  const indexes = new Map();
  const result = ts.transform(node, [
    (context) => {
      const visit = (n) => {
        if (ts.isShorthandPropertyAssignment(n)) {
          // Shorthand keys are observable protocol keys; do not erase them.
          return ts.factory.createPropertyAssignment(
            n.name.text,
            visit(n.name),
          );
        }
        if (ts.isIdentifier(n) && !propertyName(n)) {
          if (!indexes.has(n.text)) {
            indexes.set(n.text, names.length);
            names.push(n.text);
          }
          return ts.factory.createIdentifier(`__id${indexes.get(n.text)}`);
        }
        return ts.visitEachChild(n, visit, context);
      };
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    const text = printer.printNode(
      ts.EmitHint.Unspecified,
      result.transformed[0],
      ast,
    );
    return {
      hash: createHash("sha256").update(text).digest("hex"),
      names,
      kind: node.kind,
    };
  } finally {
    result.dispose();
  }
}
function externalNames(node) {
  const bound = new Set();
  function binding(n) {
    if (ts.isIdentifier(n)) bound.add(n.text);
    else ts.forEachChild(n, binding);
  }
  function visit(n) {
    if (
      n !== node &&
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n)) &&
      n.name
    )
      binding(n.name);
    if (ts.isParameter(n)) binding(n.name);
    ts.forEachChild(n, visit);
  }
  visit(node);
  const f = fingerprint(node, node.getSourceFile());
  return f.names
    .map((name, i) => (bound.has(name) ? -1 : i))
    .filter((i) => i >= 0);
}
function matchBundle(source, manifest) {
  assert.equal(manifest.schemaVersion, 1);
  const ast = ts.createSourceFile(
    "candidate.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(ast.parseDiagnostics.length, 0, "candidate syntax invalid");
  const wanted = new Set(manifest.declarations.map((d) => d.hash));
  const candidates = new Map();
  let conditionCount = 0;
  function visit(n) {
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(ast) === manifest.consumerCondition
    )
      conditionCount++;
    if (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) {
      // Only matching declaration kinds can participate; all matches must be unique.
      const f = fingerprint(n, ast);
      if (wanted.has(f.hash)) {
        const list = candidates.get(f.hash) || [];
        list.push({ node: n, ...f });
        candidates.set(f.hash, list);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  const selections = new Map(
    manifest.declarations.map((d) => [
      d,
      (candidates.get(d.hash) || []).filter(
        (c) =>
          c.kind === d.kind &&
          c.names.every(
            (name, i) =>
              !(globals.has(name) || globals.has(d.names[i])) ||
              name === d.names[i],
          ),
      ),
    ]),
  );
  function scope(n) {
    while (n.parent && !ts.isBlock(n.parent) && !ts.isSourceFile(n.parent))
      n = n.parent;
    return n.parent;
  }
  const bindings = new Map();
  const reverseBindings = new Map();
  let conflict = false,
    changed = true;
  const key = (d, name) =>
    (d.group.startsWith("protocol") ? "sdk:" : "catalog:") + name;
  while (changed && !conflict) {
    changed = false;
    // SDK declarations share one inspected module, not arbitrary nested locals.
    const sdkScopes = new Set(
      manifest.declarations
        .filter(
          (d) =>
            d.group.startsWith("protocol") && selections.get(d).length === 1,
        )
        .map((d) => scope(selections.get(d)[0].node)),
    );
    if (sdkScopes.size > 1) {
      conflict = true;
      break;
    }
    const sdkScope = [...sdkScopes][0];
    for (const d of manifest.declarations) {
      const before = selections.get(d);
      const sdk = manifest.declarations.filter((x) =>
        x.group.startsWith("protocol"),
      );
      const order = sdk.indexOf(d);
      const prev =
        order < 0
          ? []
          : sdk.slice(0, order).filter((x) => selections.get(x).length === 1);
      const next =
        order < 0
          ? []
          : sdk.slice(order + 1).filter((x) => selections.get(x).length === 1);
      const lower = prev.length
        ? selections.get(prev.at(-1))[0].node.getStart(ast)
        : -1;
      const upper = next.length
        ? selections.get(next[0])[0].node.getStart(ast)
        : Infinity;
      const filtered = before.filter(
        (c) =>
          c.node.getStart(ast) > lower &&
          c.node.getStart(ast) < upper &&
          (!d.group.startsWith("protocol") ||
            !sdkScope ||
            scope(c.node) === sdkScope) &&
          (d.references || []).every(
            (i) =>
              !bindings.has(key(d, d.names[i])) ||
              bindings.get(key(d, d.names[i])) === c.names[i],
          ),
      );
      if (filtered.length !== before.length) {
        selections.set(d, filtered);
        changed = true;
      }
      if (filtered.length === 1)
        for (const i of d.references || []) {
          const k = key(d, d.names[i]),
            value = filtered[0].names[i];
          if (bindings.has(k) && bindings.get(k) !== value) {
            conflict = true;
            break;
          }
          if (!bindings.has(k)) {
            const reverseKey = key(d, value);
            if (
              reverseBindings.has(reverseKey) &&
              reverseBindings.get(reverseKey) !== d.names[i]
            ) {
              conflict = true;
              break;
            }
            bindings.set(k, value);
            reverseBindings.set(reverseKey, d.names[i]);
            changed = true;
          }
        }
    }
  }
  const missing = manifest.declarations.filter(
    (d) => selections.get(d).length !== 1,
  );
  if (missing.length || conditionCount !== 1 || conflict)
    return {
      status: "review_required",
      mismatches: missing.map((d) => ({
        declaration: `${d.group}:${d.name}`,
        matches: selections.get(d).length,
      })),
      conditionCount,
      conflict,
    };
  const groups = {
    functions: new Map(),
    schemas: new Map(),
    protocolDefinitions: new Map(),
    protocolFunctions: new Map(),
  };
  for (const d of manifest.declarations) {
    const propertyAliases = d.group.startsWith("protocol")
      ? manifest.protocolAliases || {}
      : manifest.aliases || {};
    const candidate = selections.get(d)[0];
    assert.equal(candidate.kind, d.kind);
    assert.equal(candidate.names.length, d.names.length);
    const aliases = new Map(candidate.names.map((n, i) => [n, d.names[i]]));
    const transformed = ts.transform(candidate.node, [
      (context) => {
        const visit = (n) => {
          if (ts.isShorthandPropertyAssignment(n))
            return ts.factory.createPropertyAssignment(
              n.name.text,
              visit(n.name),
            );
          if (ts.isIdentifier(n) && !propertyName(n) && aliases.has(n.text))
            return ts.factory.createIdentifier(aliases.get(n.text));
          if (
            ts.isIdentifier(n) &&
            propertyName(n) &&
            Object.hasOwn(propertyAliases, n.text)
          )
            return ts.factory.createIdentifier(propertyAliases[n.text]);
          return ts.visitEachChild(n, visit, context);
        };
        return (root) => ts.visitNode(root, visit);
      },
    ]);
    try {
      let text = printer.printNode(
        ts.EmitHint.Unspecified,
        transformed.transformed[0],
        ast,
      );
      if (ts.isVariableDeclaration(candidate.node)) text = `var ${text};`;
      groups[d.group].set(d.name, text);
    } finally {
      transformed.dispose();
    }
  }
  return {
    status: "matched",
    groups,
    consumerCondition: manifest.consumerCondition,
  };
}
module.exports = { matchBundle, fingerprint, externalNames };
