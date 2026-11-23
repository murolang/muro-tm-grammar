#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vsctm from "vscode-textmate";
import onig from "vscode-oniguruma";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const grammarPath = path.join(root, "muro.tmLanguage.json");
const wasmPath = path.join(root, "node_modules/vscode-oniguruma/release/onig.wasm");

const failures = [];
let passed = 0;

function fail(msg) {
  failures.push(msg);
}

function ok(cond, msg) {
  if (cond) passed++;
  else fail(msg);
}

async function loadGrammar() {
  const wasmBin = fs.readFileSync(wasmPath).buffer;
  await onig.loadWASM(wasmBin);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (s) => new onig.OnigString(s),
    }),
    loadGrammar: async (scope) => {
      if (scope === "source.muro") {
        return vsctm.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath);
      }
      return null;
    },
  });
  const grammar = await registry.loadGrammar("source.muro");
  if (!grammar) throw new Error("failed to load source.muro");
  return grammar;
}

function tokenize(grammar, source) {
  const lines = source.split(/\n/);
  let ruleStack = vsctm.INITIAL;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // TextMate line tokens exclude the newline; last line may have no newline.
    const line = lines[i];
    const { tokens, ruleStack: next } = grammar.tokenizeLine(line, ruleStack);
    ruleStack = next;
    const row = tokens.map((t) => ({
      line: i + 1,
      start: t.startIndex,
      end: t.endIndex,
      text: line.slice(t.startIndex, t.endIndex),
      scopes: t.scopes,
    }));
    out.push({ line: i + 1, text: line, tokens: row });
  }
  return out;
}

function tokensCoverLine(row) {
  if (row.text.length === 0) return true;
  if (row.tokens.length === 0) return false;
  if (row.tokens[0].start !== 0) return false;
  const last = row.tokens[row.tokens.length - 1].end;
  // vscode-textmate may extend the last token to line.length+1 (the newline).
  if (last !== row.text.length && last !== row.text.length + 1) return false;
  for (let i = 1; i < row.tokens.length; i++) {
    if (row.tokens[i].start !== row.tokens[i - 1].end) return false;
  }
  return true;
}

function scopesFor(row, start, end) {
  const hits = row.tokens.filter((t) => t.start < end && t.end > start);
  return hits;
}


function lineHasScopeOn(row, snippet, scope) {
  const start = row.text.indexOf(snippet);
  if (start === -1) return false;
  const end = start + snippet.length;
  const hits = row.tokens.filter((tok) => tok.start < end && tok.end > start);
  return hits.length > 0 && hits.every((tok) => tok.scopes.includes(scope));
}

function firstTokenEq(row, text) {
  return row.tokens.find((t) => t.text === text);
}

function hasScope(token, scope) {
  return token && token.scopes.includes(scope);
}

function lineOf(rows, exact) {
  const row = rows.find((r) => r.text === exact);
  if (!row) {
    fail(`missing line: ${JSON.stringify(exact)}`);
    return null;
  }
  return row;
}

function assertTokenScope(rows, lineText, tokenText, scope, where) {
  const row = lineOf(rows, lineText);
  if (!row) return;
  const tok = firstTokenEq(row, tokenText);
  ok(
    hasScope(tok, scope),
    `${where}: expected ${JSON.stringify(tokenText)} on ${JSON.stringify(lineText)} to have ${scope}, got ${tok ? tok.scopes.join(" ") : "no token"}`,
  );
}

function bookHealth(name, source, rows) {
  for (const row of rows) {
    ok(tokensCoverLine(row), `${name}:${row.line} tokens do not cover the line`);
    for (const t of row.tokens) {
      ok(t.scopes[0] === "source.muro", `${name}:${row.line} token missing source.muro: ${JSON.stringify(t.text)} ${t.scopes}`);
    }
  }

  // A comment line (or a trailing comment) should not leak into the next line.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const idx = row.text.indexOf("--");
    if (idx === -1) continue;
    // If -- is inside a string, it is not a comment. Detect by whether the token at -- is a comment.
    const tok = row.tokens.find((t) => t.start <= idx && idx < t.end);
    if (!tok) continue;
    if (tok.scopes.some((s) => s.startsWith("string."))) continue;
    ok(
      tok.scopes.includes("comment.line.double-dash.muro"),
      `${name}:${row.line} "--" is not a comment (scopes ${tok.scopes.join(" ")})`,
    );
    // remainder of the line after a comment token should also be comment (or empty)
    for (const t of row.tokens) {
      if (t.start >= tok.start) {
        ok(
          t.scopes.includes("comment.line.double-dash.muro"),
          `${name}:${row.line} text after -- not comment: ${JSON.stringify(t.text)} ${t.scopes.join(" ")}`,
        );
      }
    }
    if (i + 1 < rows.length) {
      const next = rows[i + 1];
      const leaked = next.tokens.length > 0 && next.tokens.every((t) => t.scopes.includes("comment.line.double-dash.muro")) && next.text.trim() !== "" && !next.text.trim().startsWith("--");
      ok(!leaked, `${name}:${row.line} comment leaked into next line: ${JSON.stringify(next.text)}`);
    }
  }

  // Unclosed string should not swallow the following line.
  // (We only flag when a line is entirely still inside a string but does not look like a string.)
  let inString = false;
  // crude: if every token on a non-empty, non-comment, non-string-looking line is string.*, fail
  for (const row of rows) {
    const trimmed = row.text.trim();
    if (!trimmed) continue;
    const allString = row.tokens.length > 0 && row.tokens.every((t) => t.scopes.some((s) => s.startsWith("string.")) || t.text.trim() === "");
    const looksLikeString = /b?"/.test(trimmed) || trimmed.startsWith("\"");
    if (allString && !looksLikeString && !trimmed.startsWith("--")) {
      fail(`${name}:${row.line} swallowed as string: ${JSON.stringify(row.text)}`);
    }
  }

  // File must not be a single giant unmatched definition (everything after first def as entity.name)
  const nameTokens = rows.flatMap((r) => r.tokens.filter((t) => t.scopes.includes("entity.name.function.muro")));
  const totalNonWs = rows.flatMap((r) => r.tokens.filter((t) => t.text.trim() !== "")).length;
  ok(
    nameTokens.length < Math.max(20, totalNonWs * 0.25),
    `${name}: too many entity.name.function tokens (${nameTokens.length} / ${totalNonWs} non-ws); definition rule may be eating the file`,
  );
}

async function main() {
  const grammar = await loadGrammar();

  const snippets = tokenize(grammar, fs.readFileSync(path.join(root, "test/snippets/basics.muro"), "utf8"));

  assertTokenScope(snippets, "-- a line comment", "-- a line comment", "comment.line.double-dash.muro", "comment");
  assertTokenScope(snippets, 'import "maybe.muro"', "import", "keyword.declaration.muro", "import");
  {
    const row = lineOf(snippets, 'import "maybe.muro"');
    if (row) ok(lineHasScopeOn(row, '"maybe.muro"', "string.quoted.double.muro"), "import-string should be string.quoted.double.muro");
  }
  assertTokenScope(snippets, "data List (A : Type) : Type where", "data", "keyword.declaration.muro", "data");
  assertTokenScope(snippets, "data List (A : Type) : Type where", "List", "entity.name.function.muro", "data-name");
  assertTokenScope(snippets, "data List (A : Type) : Type where", "Type", "storage.type.muro", "Type");
  assertTokenScope(snippets, "data List (A : Type) : Type where", "where", "keyword.declaration.muro", "where");
  assertTokenScope(snippets, "  cons : A → List A → List A", "→", "keyword.operator.muro", "arrow");
  assertTokenScope(snippets, "def length : List A → Nat", "def", "keyword.declaration.muro", "def");
  assertTokenScope(snippets, "def length : List A → Nat", "length", "entity.name.function.muro", "def-name");
  assertTokenScope(snippets, "def length : List A → Nat", "Nat", "storage.type.muro", "Nat");
  assertTokenScope(snippets, "[]", "[]", "constant.language.nil.muro", "nil");
  assertTokenScope(snippets, "%0", "%0", "keyword.operator.multiplicity.muro", "%0");
  assertTokenScope(snippets, "%1", "%1", "keyword.operator.multiplicity.muro", "%1");
  assertTokenScope(snippets, "lam (x : Nat) → x", "lam", "keyword.operator.word.muro", "lam");
  {
    const row = lineOf(snippets, 'b"HTTP/1.1"');
    if (row) ok(lineHasScopeOn(row, 'b"HTTP/1.1"', "string.quoted.double.byte.muro"), "bytes should be string.quoted.double.byte.muro");
  }
  assertTokenScope(snippets, "Nat->Nat", "Nat", "storage.type.muro", "Nat-arrow-1");
  assertTokenScope(snippets, "Nat->Nat", "->", "keyword.operator.muro", "ascii-arrow");
  {
    const row = lineOf(snippets, "Nat->Nat");
    if (row) {
      const nats = row.tokens.filter((t) => t.text === "Nat");
      ok(nats.length === 2 && nats.every((t) => t.scopes.includes("storage.type.muro")), `Nat->Nat should be two Nat type tokens, got ${row.tokens.map((t) => t.text + ":" + t.scopes.at(-1)).join(" ")}`);
    }
  }
  {
    const row = lineOf(snippets, "foo-bar");
    if (row) {
      const joined = row.tokens.map((t) => t.text).join("");
      ok(joined === "foo-bar", `foo-bar should stay one ident, got ${JSON.stringify(row.tokens.map((t) => t.text))}`);
      ok(!row.tokens.some((t) => t.text === "-" && t.scopes.includes("keyword.operator.muro")), "hyphen inside foo-bar should not be an operator");
    }
  }
  {
    const row = lineOf(snippets, String.raw`"hi\"there"`);
    if (row) {
      ok(row.tokens.some((t) => t.scopes.includes("constant.character.escape.muro") && t.text === String.raw`\"`), `expected \\\" escape in string, tokens=${row.tokens.map((t)=>JSON.stringify(t.text)+t.scopes.at(-1)).join(" ")}`);
    }
  }
  bookHealth("basics.muro", "", snippets);

  const fixtures = ["list.muro", "session.muro", "request.muro", "data.muro"];
  const byName = {};
  for (const name of fixtures) {
    const source = fs.readFileSync(path.join(root, "test/fixtures", name), "utf8");
    const rows = tokenize(grammar, source);
    byName[name] = { source, rows };
    bookHealth(name, source, rows);
    ok(rows.length === source.split(/\n/).length, `${name}: line count mismatch`);
  }

  // list.muro — real stdlib
  assertTokenScope(byName["list.muro"].rows, 'import "maybe.muro"', "import", "keyword.declaration.muro", "list-import");
  {
    const row = lineOf(byName["list.muro"].rows, 'import "maybe.muro"');
    if (row) ok(lineHasScopeOn(row, '"maybe.muro"', "string.quoted.double.muro"), "list-import-str should be string.quoted.double.muro");
  }
  assertTokenScope(byName["list.muro"].rows, "data List (A : Type) : Type where", "data", "keyword.declaration.muro", "list-data");
  assertTokenScope(byName["list.muro"].rows, "data List (A : Type) : Type where", "List", "entity.name.function.muro", "list-data-name");

  // data.muro — runtime book
  assertTokenScope(byName["data.muro"].rows, "data Bool : Type where", "data", "keyword.declaration.muro", "beam-data");
  assertTokenScope(byName["data.muro"].rows, "data Bool : Type where", "Bool", "entity.name.function.muro", "beam-bool");
  assertTokenScope(byName["data.muro"].rows, "  true : Bool", "true", "keyword.control.muro", "true-is-keyword-everywhere");

  // session.muro / request.muro — byte strings and match/motive
  const req = byName["request.muro"].rows;
  const byteLine = req.find((r) => r.text.includes('b"HTTP/1.1"'));
  ok(!!byteLine, "request.muro should contain b\"HTTP/1.1\"");
  if (byteLine) {
    const tok = byteLine.tokens.find((t) => t.text.includes("HTTP/1.1") || t.text.includes('b"'));
    ok(
      byteLine.tokens.some((t) => t.scopes.includes("string.quoted.double.byte.muro")),
      `request.muro:${byteLine.line} b\"HTTP/1.1\" not scoped as byte string: ${byteLine.tokens.map((t) => JSON.stringify(t.text) + ":" + t.scopes.at(-1)).join(" ")}`,
    );
  }
  const motiveLine = req.find((r) => /\bmotive\b/.test(r.text) && !r.text.trim().startsWith("--"));
  ok(!!motiveLine, "request.muro should contain motive");
  if (motiveLine) {
    const tok = firstTokenEq(motiveLine, "motive") || motiveLine.tokens.find((t) => t.text === "motive");
    ok(hasScope(tok, "keyword.control.muro"), `motive should be a keyword on ${JSON.stringify(motiveLine.text)} got ${tok ? tok.scopes.join(" ") : "none"}`);
  }

  const sess = byName["session.muro"].rows;
  const sessLine = lineOf(sess, "session conn :=");
  if (sessLine) {
    ok(sessLine.tokens.some((t) => t.text === "session" && t.scopes.includes("keyword.declaration.muro")), "session keyword");
    ok(sessLine.tokens.some((t) => t.text === "conn" && t.scopes.includes("entity.name.function.muro")), "session name conn");
    ok(sessLine.tokens.some((t) => t.text === ":=" && t.scopes.includes("keyword.operator.muro")), "session :=");
  }
  const chunk = sess.find((r) => r.text.includes("piece-chunk") && !r.text.trim().startsWith("--"));
  ok(!!chunk, "session.muro should contain piece-chunk");
  if (chunk) {
    const tok = chunk.tokens.find((t) => t.text === "piece-chunk");
    ok(!!tok && tok.scopes.includes("variable.other.muro"), `piece-chunk should be one identifier, got ${chunk.tokens.map((t) => JSON.stringify(t.text)+":"+t.scopes.at(-1)).join(" ")}`);
  }

  if (failures.length) {
    console.error(`FAILED ${failures.length}, passed ${passed}`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log(`ok ${passed} assertions, fixtures ${fixtures.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
