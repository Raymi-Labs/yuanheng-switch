const { test } = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const {
  fingerprint,
  externalNames,
  matchBundle,
} = require("./accio-protocol-fingerprint.cjs");
const condition =
  "e.turnComplete===!1&&e.content?.parts?.some(e=>e.functionCall)";
const tail = `;if(${condition}){}`;
function manifest(source) {
  const ast = ts.createSourceFile("baseline.js", source, 99, true, 1);
  return {
    schemaVersion: 1,
    consumerCondition: condition,
    declarations: ast.statements.map((node) => ({
      ...fingerprint(node, ast),
      references: externalNames(node),
      group: "functions",
      name: node.name.text,
    })),
  };
}
test("accepts harmless local renaming and spacing but restores inspected names", () => {
  const m = manifest('function get(e){return load(e,{model:"fixed"});}');
  const result = matchBundle(
    'function other(t) { return fetcher(t, { model: "fixed" }); }' + tail,
    m,
  );
  assert.equal(result.status, "matched");
  assert.match(result.groups.functions.get("get"), /load\(e/);
});
test("rejects changed observable properties, literals, operators and appended statements", () => {
  const m = manifest('function get(e){return load(e,{model:"fixed"});}');
  for (const s of [
    'function get(e){return load(e,{token:"fixed"});}',
    'function get(e){return load(e,{model:"other"});}',
    'function get(e){send(e);return load(e,{model:"fixed"});}',
    'function get(e){return load(e,{model:"fixed"})||true;}',
  ])
    assert.equal(matchBundle(s + tail, m).status, "review_required");
});
test("ambiguous and missing declarations are review results, never first-match success", () => {
  const m = manifest('function get(e){return load(e,{model:"fixed"});}');
  assert.equal(
    matchBundle(
      'function a(e){return load(e,{model:"fixed"});}function b(e){return load(e,{model:"fixed"});}' +
        tail,
      m,
    ).status,
    "review_required",
  );
  assert.equal(matchBundle(tail, m).status, "review_required");
});
test("preserves dependency relationships across renamed declarations", () => {
  const m = manifest(
    'function one(e){return send(e,"one");} function two(e){return send(e,"two");}',
  );
  assert.equal(
    matchBundle(
      'function a(t){return x(t,"one");} function b(t){return x(t,"two");}' +
        tail,
      m,
    ).status,
    "matched",
  );
  assert.equal(
    matchBundle(
      'function a(t){return x(t,"one");} function b(t){return y(t,"two");}' +
        tail,
      m,
    ).status,
    "review_required",
  );
});
test("consumer condition must occur exactly once and shorthand keys stay observable", () => {
  const m = manifest("function one(e){return {e};}");
  assert.equal(
    matchBundle("function a(t){return {t};}" + tail, m).status,
    "review_required",
  );
  assert.equal(
    matchBundle("function one(e){return {e};}" + tail + tail, m).status,
    "review_required",
  );
});
test("global capabilities cannot be renamed into safe stubs", () => {
  const m = manifest("function one(e){return JSON.parse(e);}");
  assert.equal(
    matchBundle("function a(t){return dangerous.parse(t);}" + tail, m).status,
    "review_required",
  );
  const n = manifest('function one(e){return call(e,"one");}');
  assert.equal(
    matchBundle('function a(t){return eval(t,"one");}' + tail, n).status,
    "review_required",
  );
});
