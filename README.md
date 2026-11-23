# Muro TextMate grammar

[TextMate](https://macromates.com/manual/en/language_grammars) grammar for the [Muro](https://muro-lang.dev) programming language. Scope name: `source.muro`. File extension: `.muro`.

The language is [murolang/muro](https://github.com/murolang/muro). This grammar classifies the same words the Muro lexer does, in every position; the checker still decides where a word is reserved. Word lists come from `Muro.Words` (`lib/muro/words.ex`) as of [murolang/muro@3a5369f](https://github.com/murolang/muro/blob/3a5369fb325141d0228c33536ead26f26a7d5ae0/lib/muro/words.ex).

It does **not** highlight [Koyu](https://koyucore.dev) architectural `.muro` files. That is a different language that also uses the extension.

License: MIT, Copyright (c) 2026 Murolang.

## What is highlighted

- Line comments starting with `--`
- Strings `"…"` and byte strings `b"…"`, including the escapes `\\` and `\"` the lexer recognizes. Strings do not span lines.
- The nil token `[]`, and the multiplicities `%0` and `%1`
- Declaration words (`def`, `data`, `import`, `session`, …). `spec`, `run`, and `evidence` are types in the lexer, not declarations, and are highlighted as types.
- The name being defined after a naming word (`def`, `data`, and the other naming declarations)
- Type words (`Type`, `Nat`, `Bytes`, …)
- Keywords (`match`, `motive`, `let`, …)
- Operators (`→`, `->`, `:=`, `λ`, `lam`, `Pi`, …) and decimal integers

## Use

### VS Code / Cursor

Clone this repository and load it as an extension folder:

```sh
code --install-extension /path/to/muro-tm-grammar
```

Or `Developer: Install Extension from Location…` and pick this folder. Files ending in `.muro` then use language id `muro`.

### Sublime Text

Copy `muro.tmLanguage.json` into a package directory, for example `Packages/Muro/`, and restart. The `fileTypes` entry already lists `muro`.

### Shiki

```js
import muro from "./muro.tmLanguage.json" with { type: "json" };

const highlighter = await createHighlighter({
  langs: [muro],
  themes: ["github-light"],
});
```

The grammar's `scopeName` is `source.muro`.

### GitHub Linguist

This repository is the grammar to add later with Linguist's `script/add-grammar https://github.com/murolang/muro-tm-grammar`. Muro is not in Linguist yet; GitHub will not show a "Muro" language bar until that lands.

## Tests

```sh
npm install
npm test
```

The tests tokenize the real books under `test/fixtures/` and check scopes on representative lines.
