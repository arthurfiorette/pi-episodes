# Task mining: ts-json-schema-generator

Research report for the benchmark in `bench/PLAN.md`. Everything below was measured on 2026-10-13 in a fresh clone at `/private/var/folders/qn/39h52ty90358d4l9tn8362700000gn/T/opencode/tsjsg-research` (Apple M4 Pro, 12 cores, 24 GB, node v26.7.0). Items not verified are marked as such.

## 1. Repo facts

| Item | Value |
|---|---|
| HEAD | `2cbae2e355a3a56bef63df196c23b1e6b4c8628e` (2026-10-01, `chore(deps-dev): bump vega from 6.2.0 to 6.4.0 (#2549)`) |
| Upstream | vega/ts-json-schema-generator; nothing merged after 2026-10-01 except dependabot (checked with `gh api .../pulls?state=closed`) |
| package.json version | 2.0.0 (releases are cut by `auto`, the file is not bumped) |
| Package manager | npm (`"packageManager": "npm@11.12.1"`, `package-lock.json`); local npm 12.0.2 works |
| Node | `"engines": { "node": ">=22.0.0" }`; measured with v26.7.0 |
| Install | `npm ci --ignore-scripts` (6 s with warm cache) |
| Build | `npx tsc` (1.8 s; emits to `dist/`, `incremental: true` so `dist/tsconfig.tsbuildinfo` appears) |
| Typecheck only | `npx tsc --noEmit` (tsconfig covers `src/`, `factory/`, `index.ts`, `ts-json-schema-generator.ts`; test files are NOT type-checked by tsc, only by eslint's tsconfig) |
| Lint | `npm run lint` (eslint 10 + prettier). CI runs lint, build, `test:coverage` |
| Test runner | node:test via tsx: `npm test` = `tsx --test "test/**/*.test.ts"`. One `index.test.ts` per fixture directory (switched from jest in #2413, 2025-12-01; `test/README.md` is stale and still describes jest) |
| Suite at HEAD | passes: 379 tests, 11 suites, 0 fail |

Timings (wall clock, this machine):

| Command | Wall | Tests |
|---|---|---|
| `npm test` (full) | 73 s (658 s CPU, ~10 cores busy) | 379 |
| `npm run test:fast` (`FAST_TEST=1`, skips per-fixture type check) | 53 s | 379 |
| `npx tsx --test "test/valid-data/**/*.test.ts"` | 55 s | 258 |
| `npx tsx --test "test/unit/**/*.test.ts"` | 1.4 s | 72 |
| `npx tsx --test test/vega-lite/vega-lite.test.ts` | 1.5 s | 1 |
| `npx tsx --test test/valid-data/import-dynamic/index.test.ts` (one fixture) | 1.4 s | 1 |
| same with `FAST_TEST=1` | 1.0 s | 1 |
| `npx tsx --test --test-name-pattern=type-mapped-required "test/**/*.test.ts"` | 20 s | still spawns all 300+ files; useless as a filter |
| `npx tsc --noEmit` | ~2 s | |

Notes:

- PLAN.md says the suite takes about 10 minutes. On this machine it is 73 s. vega-lite is not the slow part: generating the 1.9 MB vega-lite schema takes 1.6 s (`npx tsx ts-json-schema-generator.ts --path node_modules/vega-lite/src/index.ts --type TopLevelSpec --no-ref-encode --no-type-check`). The cost is 258 valid-data fixtures each creating a TS program with type checking (1 to 1.7 s each), and node:test parallelizes across files, so a 2-core CI box would see ~5 to 10 minutes.
- Fast subset: pass file paths, e.g. `npx tsx --test test/valid-data/<name>/index.test.ts [more files]`. `--test-name-pattern` does not avoid spawning every file.
- Regenerating a fixture's expected schema: `UPDATE_SCHEMA=true npx tsx --test test/valid-data/<name>/index.test.ts` (writes `schema.json`). `npm run test:update` does this for everything.
- Output size: a passing full run is 430 lines / 24.6 KB (one line per test with timing).

## 2. Architecture for task writers

Flow for one root type name (`SchemaGenerator.createSchema`, `src/SchemaGenerator.ts`):

1. `getRootNodes` finds the `ts.Node` for the requested type name(s) by walking source files.
2. `nodeParser.createType(node, new Context())` turns the AST node into a `BaseType` tree (`src/Type/*.ts`, 29 classes: `ObjectType`, `UnionType`, `TupleType`, `RestType`, `FunctionType`, `AnnotatedType`, `DefinitionType`, `ReferenceType`, ...).
3. `typeFormatter.getDefinition(rootType)` turns the type tree into a JSON Schema `Definition` (= `JSONSchema7`), and `typeFormatter.getChildren(rootType)` collects `DefinitionType`s to emit under `definitions`. `removeUnreachable` prunes definitions not referenced from the root.

The parser side (`factory/parser.ts`, 198 lines): `createParser` builds one `ChainNodeParser` and registers 56 `SubNodeParser`s in a fixed order (first `supportsNode(node)` wins; `src/ChainNodeParser.ts` caches by node + context key and throws `UnknownNodeError('Unknown node of kind "X"')` if none matches). A `SubNodeParser` is two methods: `supportsNode(node): boolean` (almost always `node.kind === ts.SyntaxKind.Something`) and `createType(node, context): BaseType`, which recurses via the injected `childNodeParser` (the chain itself). Declaration parsers (TypeAlias, Enum, InterfaceAndClass, TypeLiteral) are wrapped: `withCircular(withExpose(withJsDoc(parser)))`:

- `withJsDoc` = `AnnotatedNodeParser` + an `AnnotationsReader` (`BasicAnnotationsReader` for `jsDoc: "basic"`, `ExtendedAnnotationsReader` for `"extended"`, nothing for `"none"`). It wraps the result in `AnnotatedType(type, annotations, nullable)`.
- `withExpose` = `ExposeNodeParser`, wraps exported declarations in `DefinitionType(name, type)` so they land in `definitions`.
- `withCircular` = `CircularReferenceNodeParser`, hands out a `ReferenceType` placeholder for recursive types.
- `TopRefNodeParser` wraps the whole chain and decides whether the root gets a `$ref`.

The formatter side (`factory/formatter.ts`, 87 lines): `createFormatter` builds a `ChainTypeFormatter` with 28 `SubTypeFormatter`s (`supportsType(type) = type instanceof X`, `getDefinition(type)`, `getChildren(type)`), wrapped in `CircularReferenceTypeFormatter`. Formatters that recurse receive `circularReferenceTypeFormatter` as `childTypeFormatter`. Config reaches formatters as constructor args (`encodeRefs`, `functions`, `discriminatorType`).

Annotations (`src/AnnotationsReader/`): `BasicAnnotationsReader` has two static sets, `textTags` (title, description, format, pattern, $ref, $comment, discriminator, ...) and `jsonTags` (minimum, maxItems, default, examples, deprecated, ...; values parsed with json5), plus `extraTags` from config. `ExtendedAnnotationsReader` adds `description` from the doc comment, `markdownDescription`, `fullDescription`, `@asType`, `@example`, and `@nullable`. `AnnotatedTypeFormatter` merges annotations over the child definition and handles `@discriminator` and nullable.

Config (`src/Config.ts`): 19 options with JSDoc, `DEFAULT_CONFIG`. CLI in `ts-json-schema-generator.ts` (commander). Programmatic: `factory/generator.ts` `createGenerator(config)`.

Test fixtures:

- `test/valid-data/<name>/{main.ts, schema.json, index.test.ts}` (252 dirs). `index.test.ts` is 3 to 20 lines: `test("valid-data - <name>", assertValidSchema("<name>", "RootTypeName", configOverrides?, { validSamples, invalidSamples, ajvOptions, mainTsOnly }))`. `assertValidSchema` (`test/utils.ts`) builds a generator over `test/valid-data/<name>/*.ts`, generates, `deepStrictEqual`s against `schema.json`, validates the schema with Ajv, compiles it (catches missing `$ref`s), and optionally validates sample data.
- `test/config/<name>/` (37 dirs) use `assertConfigSchema(name, config)` for config-option tests.
- `test/invalid-data/<name>/` (5) use `assertInvalidSchema(name, type, expectedMessage)`.
- `test/unit/*.test.ts` (72 tests), `test/vega-lite/vega-lite.test.ts` (one big golden file), `test/minify`, `test/sourceless-nodes`.
- Upstream bug found while verifying: `test/valid-data/type-mapped-inherit-optional/index.test.ts` calls `assertValidSchema(...)` without wrapping it in `test(...)`, so it never runs; and its `schema.json` does not match its own config (`$ref: Headmatter` vs type `"*"`). With the test fixed it fails even at HEAD. Do not use PR #2521 as a task without fixing the fixture first.

"Small, similar but not the same" pairs (the pattern the user wants exercised):

1. `src/NodeParser/AsExpressionNodeParser.ts` / `SatisfiesNodeParser.ts` / `ParenthesizedNodeParser.ts`: identical pass-through parsers (`createType` = `childNodeParser.createType(node.expression ...)`) differing only in `SyntaxKind`. `OptionalTypeNodeParser` vs `RestTypeNodeParser`: both wrap the child type in a wrapper type (`OptionalType` / `RestType`); the formatters differ in that `RestTypeFormatter` also injects a `title` into `items` when the rest element is named.
2. `StringTypeNodeParser`+`StringTypeFormatter`+`StringType` vs `SymbolTypeNodeParser`+`SymbolTypeFormatter`+`SymbolType`: same three-file shape for a keyword type; the string formatter emits `{ type: "string" }`, the symbol formatter emits `{}`; `StringType` carries a `preserveLiterals` flag the other lacks.
3. `CallExpressionParser` vs `NewExpressionParser` (#2346): same structure (`typeChecker.getTypeAtLocation`, `typeToTypeNode`, `createSubContext` pushing argument types); the call version has two special cases (tuple-of-literals, `unique symbol`) the new-expression version dropped. Likewise `TypeReferenceNodeParser` vs `ImportTypeNodeParser` (#2535): both resolve a symbol and push `typeArguments` into a sub-context; the import version handles `node.qualifier` and alias symbols. And `FunctionNodeParser`/`FunctionTypeFormatter` vs `ConstructorNodeParser`/`ConstructorTypeFormatter` (the latter is 9 lines extending the former).

## 3. Task candidates from git history

Method: `git log --since=2024-09-01` filtered to feature-like commits touching `src/` + `test/valid-data` (or `test/config`). For each, the non-test part was reverse-applied in the research clone (`git diff sha^ sha -- src factory ts-json-schema-generator.ts | git apply -R`), then `tsc --noEmit`, then the commit's fixture(s) were run (expect fail), then restored (expect pass). Script and logs in `/private/var/folders/qn/39h52ty90358d4l9tn8362700000gn/T/opencode/`: `tsjsg-revert-check.sh`, `tsjsg-reverts.log`. "Self-contained" = with the feature reverted and its fixtures removed/rolled back, `FAST_TEST=1` full suite passes (`tsjsg-selfcontained.sh`, `tsjsg-selfcontained.log`). See the table at the end of this section. Chain sequences were verified in a second scratch clone `tsjsg-r2` (symlinked `node_modules`).

Legend: src = files under `src/`, `factory/`, CLI; test = files under `test/`. "fixture fails without" = verified by actually reverting.

### Tier 1: 2026 commits, verified

**C1. `51e4c052` 2026-07-02, PR #2535 "feat: support dynamic import nodes" (Boris Serdiuk)**
src: `factory/parser.ts` (+2), new `src/NodeParser/ImportTypeNodeParser.ts` (+42). test: new `test/valid-data/import-dynamic/{main.ts,module.ts,reexport.ts,schema.json,index.test.ts}` (+58). Revert: clean; tsc OK; fixture fails without (`Unknown node of kind "LastTypeNode"`, the TS enum alias for `ImportType`), passes with.
Issue text: "Using an inline `import("./module").MySubObject<string>` type in an interface property crashes the generator with `Unknown node of kind "LastTypeNode"`. We use this form a lot for types from other files without top-level imports (including when the type is re-exported through an intermediate module, and with type arguments). Could the generator resolve these the same way it resolves a normal type reference?"

**C2. `7e04b11d` 2026-06-19, PR #2512 "feat: support ReturnType<T>, type predicates, and fix typeof for function declarations" (Jonathan Puckey)**
src: `FunctionNodeParser.ts` (+30, adds `getReturnType`), `TypeofNodeParser.ts` (+9), `Type/FunctionType.ts` (+5, `returnType`), `Utils/isAssignableTo.ts` (+41, function-type assignability with `infer` in return position). test: new `type-predicate`, `type-utility-parameters`, `type-utility-return-type`, `type-utility-return-type-arrow`; modified `type-typeof-function/schema.json` (+335/-1). Revert: clean; tsc OK; 5 fixtures fail without, pass with. Depends on C3 (same `isAssignableTo` block); reverting C3 on top of HEAD conflicts unless C2 is reverted first (verified: reverting both is clean and leaves tsc OK).
Issue text: "`ReturnType<typeof myFunction>` produces an empty/`any`-ish schema instead of the function's return type, for both `function` declarations and arrow functions. Also, functions with type predicates (`value is string`, `asserts value`) should be treated as returning `boolean` / `void`. And `Parameters<typeof fn>` only works for inline function types, not for `typeof` a declared function."

**C3. `bb805d5d` 2026-03-25, PR #2495 "Add support for `infer` in conditionals operating on function parameters" (Ninjackson)**
src: `FunctionNodeParser.ts` (+7, `(...args: infer T)` special case), `Utils/isAssignableTo.ts` (+15). test: new `type-conditional-infer-function` (+30; main.ts is one line: `export type FuncParams = Parameters<(a: string, b: number) => void>;`). Revert at HEAD: conflicts with C2 (verified); reverting C2 then C3 is clean, and after re-applying C3 alone only this fixture passes while C2's five still fail (verified). Self-contained only as the first half of the C3 -> C2 chain.
Issue text: "`Parameters<(a: string, b: number) => void>` throws instead of producing a tuple schema `[string, number]`. Conditional types with `infer` already work for arrays and tuples, so it looks like function parameter positions just aren't handled."

**C4. `8d536a44` 2026-03-14, PR #2492 "fix: mapped types required type" (Antonin CELESTIN)**
src: `MappedTypeNodeParser.ts` (+19/-2, `isMappedPropertyRequired`, handles `-?`). test: new `type-mapped-required`, `type-mapped-enum-required` (+68). Revert: clean; tsc OK; both fixtures fail without (`required` missing), pass with.
Issue text: "`Required<T>` has no effect: for `interface WithOptional { foo?: number; bar?: string }`, `Required<WithOptional>` generates a schema with no `required` array. Same for a mapped type over an enum's keys with `?` then wrapped in `Required<>`. The `-?` modifier should make properties required."

**C5. `f4b9d904` 2026-03-17, PR #2496 "fix: array ref used as rest item" (Antonin CELESTIN)**
src: `TypeFormatter/TupleTypeFormatter.ts` (+19/-1, resolve `$ref` rest element through `derefType`). test: new `type-aliases-tuple-rest-array-ref` (+26). Revert: clean; tsc OK; fixture fails without (`maxItems: 1`, no `additionalItems`), passes with.
Issue text: "With `export type RestItems = string[]; export type TupleWithRestRef = [number, ...RestItems];` the tuple schema gets `maxItems: 1` and no `additionalItems`, so the rest part is lost. Writing `...string[]` inline works. The alias should behave the same."

**C6. `eb8abd78` 2026-03-11, PR #2477 "fix: Include types referenced only in `additionalItems` in schema definitions" (Antonin CELESTIN)**
src: `Utils/removeUnreachable.ts` (+5). test: new `type-aliases-tuple-rest-additional-only` (+68). Revert: clean; tsc OK; fixture fails without (definition `AdditionalItem` missing, so Ajv compile fails on the dangling `$ref`), passes with.
Issue text: "For `export type MyTuple = [FirstItem, ...AdditionalItem[]]` (both classes exported), the generated schema references `#/definitions/AdditionalItem` in `additionalItems` but the definition itself is missing, so the schema is invalid. `FirstItem` is emitted fine."

**C7. `32c3be61` 2026-01-29, PR #1836 "fix: error 'has multiple definitions' with discriminate unions" (Julian Bez)**
src: `SchemaGenerator.ts` (+18/-3, compare base type ids ignoring `AnnotatedType` wrapper). test: new `discriminator-recursive` (+86; config `jsDoc: "basic", discriminatorType: "open-api"`, type `"*"`). Revert: clean; tsc OK; fixture fails without (`MultipleDefinitionsError`), passes with.
Issue text: "A discriminated union (`@discriminator animal_type`) that is referenced recursively from one of its own members (`Bird.likes_to_eat: Animal`) fails with `Type "Animal" has multiple definitions.` Adding an intermediate alias avoids it, but that is not practical for us."

**C8. `f6e2ce77` 2026-07-01, PR #2534 "fix: preserve JSDoc description on properties with an inferred default value" (Vismay)**
src: `InterfaceAndClassNodeParser.ts` (+9, set `parent` on synthesized type node). test: new `class-jsdoc-default` (+47). Revert: clean; tsc OK; fixture fails without (descriptions dropped), passes with.
Issue text: "In an exported class, `/** Property x description */ public x = "foo";` loses its description in the schema (same for number and boolean initializers); with an explicit `: string` annotation the description is kept. Properties whose type is inferred from the initializer should keep their JSDoc."

**C9. `75d1e266` 2026-03-23, PR #2501 "fix: preserve mapped indexed access annotations"**
src: `factory/parser.ts` (1 line: `IndexedAccessTypeNodeParser` gets `withJsDoc(chainNodeParser)`). test: new `type-mapped-indexed-access-annotation` (+52). Revert: 3-way OK; tsc OK; fixture fails without (`pattern` annotation lost), passes with. Too small alone (1 line); good as a third step of a mapped-type chain or as a probe.
Issue text: "A mapped type whose value is an indexed access into another type (`{ [key in keyof AllFields]?: UrlTypes["url"] }` where `UrlTypes.url` has `@pattern ^https:\/\/.*$`) loses the `pattern` keyword in the output. Using `UrlTypes["url"]` directly as a property type keeps it. Annotations on the referenced property should carry through the mapped type too."

### Tier 2: 2025 commits, verified

**C10. `f74dc48b` 2025-11-30, PR #2411 "feat: add support for BinaryExpression node" (Sam Sudar)**
src: `factory/parser.ts` (+2), new `BinaryExpressionNodeParser.ts` (+99). test: new `binary-expression` (main.ts 66 lines covering `+`, `*`, `||`, unions, any, unknown). Revert: clean; tsc OK; fixture fails without (`Unknown node of kind "BinaryExpression"`), passes with. The old commit also edited the since-deleted `test/valid-data-type.test.ts`; irrelevant now because the fixture has its own `index.test.ts`.
Issue text: "An `as const` object with computed values like `numbers: 60 * 5`, `stringLiterals: "a" + "b"`, `booleanTypes: a || b` crashes `typeof foo` schema generation with `Unknown node of kind "BinaryExpression"`. Widening to the result type (`number`, `string`, `boolean`) would be enough; exact constant evaluation is not needed."

**C11. `150e27d3` 2025-09-04, PR #2346 "feat: add `NewExpression` parser" (James Vaughan)**
src: `factory/parser.ts` (+2), new `NewExpressionParser.ts` (+46). test: new `class-new-expression` (+16; `const obj = new MyObject(); export type MyType = typeof obj;`). Revert: clean; tsc OK; fixture fails without (`Unknown node of kind "NewExpression"`), passes with. Small and nearly a copy of `CallExpressionParser`; good as a warm-up or first half of a chain.
Issue text: "`typeof obj` where `const obj = new MyObject()` throws `Unknown node of kind "NewExpression"`. `typeof` of a call expression result works, so `new` should too."

**C12. `cb99f6ec` 2025-06-08, PR #2269 "feat(parser): support SpreadElement in array literals" (Alex)**
src: `factory/parser.ts` (+4), new `IdentifierNodeParser.ts` (+38), new `SpreadElementNodeParser.ts` (+25). test: new `array-literal-spread`, `array-rest-only` (+45). Revert: automatic apply conflicts (later insertions nearby in `factory/parser.ts`); manual revert (delete the two files, delete their 4 lines in `factory/parser.ts`) verified: tsc OK; `array-literal-spread` fails without (`Unknown node of kind "SpreadElement"`); `array-rest-only` passes even without (it exercises `[...string[]]`, already supported), so only the first fixture discriminates.
Issue text: "`const BASE = ["foo", "bar"] as const; export const ALL = [...BASE, "baz"] as const; export type MyType = typeof ALL;` fails with `Unknown node of kind "SpreadElement"`. Expected a tuple schema with the spread items expanded."

**C13. `53c8da28` 2025-06-11, PR #2224 "feat: Add --full-description option to include full comment in schema" (Alex)**
src: `factory/parser.ts` (+7/-2), `ExtendedAnnotationsReader.ts` (+35/-11), `Config.ts` (+2), new `Utils/getFullDescription.ts` (+39), CLI (+9). test: new `test/config/full-description/{main.ts (169 lines), schema.json}`, `test/unit/getFullDescription.test.ts` (236 lines), README option line. Revert: automatic apply conflicts in `Config.ts` (JSDoc on options added later); manual revert verified (tsc OK, config fixture and unit test fail without). The only option/annotation-reader feature in range; shape differs from parser tasks (Config + CLI + reader + README).
Issue text: "`--markdown-description` keeps formatting but drops `@`-tags. We need the whole JSDoc block verbatim (minus the comment stars) as a `fullDescription` keyword, controlled by a new `--full-description` flag / `fullDescription` config option, alongside `description`. Should imply `jsDoc: "extended"`."

**C14. `147efddb` 2025-12-01, PR #2412 "narrow AnyType to StringType in mapped types" (Sam Sudar)**
src: `MappedTypeNodeParser.ts` (+3/-1). test: new `type-mapped-any`, `type-mapped-template-literal` (+46). Revert: clean; `type-mapped-any` fails without (`Unexpected key type "any"`), `type-mapped-template-literal` passes without (so one of the two discriminates).
Issue text: "A mapped type whose key constraint is `any` (`Record<any, string>`, or prosemirror's `interface Spec<Nodes extends string = any> { nodes: { [name in Nodes]: NodeSpec } }`) throws `Unexpected key type "any" for this node. (expected "UnionType" or "StringType")`. Treating `any` keys as `string` would give a sensible `additionalProperties` schema."

**C15. `53f3f817` 2025-12-01, PR #2418 "fix: mapped number types in Record syntax" (Sam Sudar)**
src: `MappedTypeNodeParser.ts` (+9/-7). test: modifies existing `type-mapped-number` (main.ts +4, schema.json, index.test.ts). Revert: 3-way OK; fixture fails without (`Record<number, string>` emitted as array), passes with. Held-out setup must roll the fixture dir back to its pre-commit state rather than delete it.
Issue text: "`Record<number, string>` is generated as `{ type: "array", items: { type: "string" } }`. The equivalent `{ [key: number]: string }` generates an object with `additionalProperties`. Both should produce the object form."

**C16. `de2ea6e2` 2025-12-04, PR #2421 "fix: generic index access constraint case" (#542)**
src: `IndexedAccessTypeNodeParser.ts` (+4/-1). test: new `generic-indexed-access-constraint` (+28). Revert: clean; fixture fails without (`Invalid index "a" in type ...`), passes with. Tiny; probe-sized.
Issue text: "`interface MyGeneric<T extends { a?: string; b: number }> { a?: T["a"]; b: T["b"] }` used as `MyGeneric<{ b: number }>` throws `Invalid index "a"`: the indexed access should fall back to the type parameter's constraint when the argument lacks the key. This breaks Prisma-generated types."

### Tier 3: listed, not verified by revert (older or different shape)

- **C17. `ce1a6709` 2025-11-30, PR #2410 "feat: add support for a types array"** src: CLI, `Config.ts`, `SchemaGenerator.ts`, `factory/parser.ts`, new `Utils/castArray.ts` (+37/-10); test: `test/config/multiple-types`, `multiple-types-all`, invalid-data case (+197). Different subsystem (root selection, CLI). Likely conflicts with the later CLI change `41b841ce`. Not reverted.
- **C18. `c8ea3ed6` 2025-02-18, PR #2159 "fix: support for generic functions"** 8 src files (+53/-11) including `ChainNodeParser`, `UnknownType`; fixture `function-generic` (190-line schema). Not reverted.
- **C19. `ddd2d2cf` 2025-01-08, PR #2149 "go back to generating enums out of unions containing enums"** `EnumTypeFormatter`, `LiteralUnionTypeFormatter` (+86/-46); fixtures `enums-union`, `exported-enums-union`. Formatter-side task. Not reverted.
- **C20. `8c44ddf8` 2025-05-16, PR #2232** + `75609528` 2025-04-14 PR #2230: mapped keys through union aliases (`MappedTypeNodeParser`, `derefType`); fixtures `type-mapped-exported-aliases`, `type-mapped-pick-union-alias`. Not reverted.
- **C21. `22b03e52` 2025-07-07, PR #2305** `--additional-properties` with mapped/intersection helpers; 4 `test/config/mapped-*` fixtures; src +3/-3. Not reverted.
- **C22. `183b4264` 2024-05-20, PR #1924 Promise handling** (new `PromiseNodeParser`, +119); revert conflicts (`TypeReferenceNodeParser` changed since). Also changed `test/vega-lite/schema.json`. Not usable without manual work.
- **C23. `91a0c9f8` 2024-04-12, PR #1910 "feat!: improve support for function types"** 95 files, 2309/-2087, touches every formatter's signature. Too big and not self-contained.
- **C24. `1b27258a` 2024-05-23, PR #1962 `export *` support** `SchemaGenerator.ts` +131/-72. Not reverted.
- **Rejected: `c333f883` 2026-05-01 PR #2521** (fixture never runs and is wrong; see section 2).

### Self-containment table (FAST_TEST full suite with feature reverted and its fixtures removed)

Each row: src diff reverse-applied, the commit's new fixture dirs deleted, modified fixtures rolled back to the parent commit, then `FAST_TEST=1 npx tsx --test "test/**/*.test.ts"`. Wall times are inflated in some rows by other runs on the same machine.

| Commit | PR | Revert | tsc | Fixture(s) fail without / pass with | Rest of suite (feature reverted, fixtures removed) |
|---|---|---|---|---|---|
| `51e4c052` | #2535 ImportType | clean | OK | 1/1 | 378/378 pass |
| `7e04b11d` | #2512 ReturnType, predicates | clean | OK | 5/5 (incl. rolled-back `type-typeof-function`) | 375/375 pass |
| `bb805d5d` | #2495 Parameters<T> | conflicts at HEAD; clean after `7e04b11d` reverted | OK | 1/1 | covered by the chain run above (unverified alone) |
| `8d536a44` | #2492 Required<T> | clean | OK | 2/2 | 377/377 pass |
| `f4b9d904` | #2496 tuple rest `$ref` | clean | OK | 1/1 | 378/378 pass |
| `eb8abd78` | #2477 `additionalItems` reachability | clean | OK | 1/1 | 378/378 pass |
| `32c3be61` | #1836 discriminator recursive | clean | OK | 1/1 | 378/378 pass |
| `f6e2ce77` | #2534 class JSDoc default | clean | OK | 1/1 | 378/378 pass |
| `75d1e266` | #2501 indexed access annotations | 3-way | OK | 1/1 | 378/378 pass |
| `f74dc48b` | #2411 BinaryExpression | clean | OK | 1/1 | 378/378 pass |
| `150e27d3` | #2346 NewExpression | clean | OK | 1/1 | 378/378 pass |
| `cb99f6ec` | #2269 SpreadElement | manual (2 files + 4 lines) | OK | 1 of 2 (`array-rest-only` passes anyway) | not run (manual revert; expected to pass, unverified) |
| `53c8da28` | #2224 fullDescription | manual (Config.ts) | OK | 2/2 (config fixture + unit test) | not run (unverified) |
| `147efddb` | #2412 `any` mapped keys | clean | OK | 1 of 2 (`type-mapped-template-literal` passes anyway) | 377/377 pass |
| `53f3f817` | #2418 `Record<number,..>` | 3-way | OK | 1/1 (modified fixture, rolled back) | 379/379 pass |
| `de2ea6e2` | #2421 generic index constraint | clean | OK | 1/1 | 378/378 pass |
| `c333f883` | #2521 | clean | OK | fixture never runs; broken upstream | n/a, rejected |

## 4. Chaining candidates

**Chain A (recommended): function type utilities. C3 (#2495, 2026-03-25) then C2 (#2512, 2026-06-19).**
Dependency: C2 literally edits the block C3 added in `isAssignableTo.ts` (the `target instanceof FunctionType` branch) and extends `FunctionType`/`FunctionNodeParser.getNamedArguments` with a sibling `getReturnType`. Verified: with both reverted all 6 fixtures fail, after C3 only `type-conditional-infer-function` passes, after C2 all pass; tsc OK at every stage.
Goal 1 as stated to the agent: "make `Parameters<(a: string, b: number) => void>` work". Sub-goals: find where conditional `infer` is resolved (`ConditionalTypeNodeParser` -> `isAssignableTo` with `inferMap`), see that `FunctionType` is opaque to it, teach `getNamedArguments` the `(...args: infer T)` shape, add fixture, run it, run suite.
Goal 2: "make `ReturnType<typeof fn>` and `Parameters<typeof fn>` work, and type predicates". Reuse: the agent would not need to re-read `isAssignableTo.ts` (14 KB), `FunctionNodeParser.ts`, `FunctionType.ts`, `ConditionalTypeNodeParser.ts`, `InferType.ts`, `test/utils.ts`, or `factory/parser.ts`; a fold note like "Parameters<T> works by isAssignableTo matching FunctionType.namedArguments against an InferType; FunctionType holds node + namedArguments" lets it go straight to adding `returnType` and the `typeof` path in `TypeofNodeParser` (the one new file it must read, 4 KB). Probe: "which util decides whether `infer R` binds in the return position?".
Held-out: `type-conditional-infer-function` for goal 1; `type-utility-return-type`, `type-utility-return-type-arrow`, `type-utility-parameters`, `type-predicate` for goal 2, plus rolling back `type-typeof-function/schema.json` to its pre-#2512 content at setup and restoring the new content at check time.

**Chain B: expression parsers. C11 (#2346 NewExpression, 2025-09) then C10 (#2411 BinaryExpression, 2025-11), optionally then C1 (#2535 ImportType, 2026-07).**
Dependency: identical shape (new `SubNodeParser` file, `supportsNode` on a `SyntaxKind`, one `addNodeParser` line in `factory/parser.ts`, one fixture dir); same failure signature (`Unknown node of kind "..."`). Each is independent in code (no shared lines), so it is a "same pattern" chain, not a "same lines" chain, which makes the reuse measurable: in goal 2 the agent should not re-read `NodeParser.ts`, `SubNodeParser.ts`, `ChainNodeParser.ts`, `factory/parser.ts` (11.7 KB), `test/utils.ts`, or an example fixture; it needs only `CallExpressionParser.ts` (goal 1 model) / the `Type` classes it combines (goal 2: `StringType`, `NumberType`, `BooleanType`, `LiteralType`, `UnionType`, `AliasType`) / `TypeReferenceNodeParser.ts` (goal 3 model). Verified: all three revert cleanly, tsc OK, fixtures flip. Goal 2 is the meatiest (99-line parser with union/alias widening rules and a 66-line fixture). Put C1 (2026) last if three goals are wanted.

**Chain C: mapped types. C15 (#2418 `Record<number,...>`) + C14 (#2412 `any` keys) as goal 1 (same file, same day, same author), then C4 (#2492 `Required<T>` / `-?`) as goal 2, optionally C9 (#2501, one line in `factory/parser.ts`) as goal 3.**
Dependency: all inside `MappedTypeNodeParser.ts` (8.9 KB, the largest parser): goal 1 touches `createType`'s key-type dispatch (`constraintType` is `NumberType` / `AnyType`), goal 2 touches `getProperties`/`getValues` (`questionToken`). Reuse: in goal 2 the agent should not re-read `MappedTypeNodeParser.ts` in full, `typeKeys.ts`, `ObjectType.ts`, or the test harness; it should remember the two property-building paths (`getProperties` for union keys, `getValues` for enum keys) and go to the `required` argument of `new ObjectProperty(...)`. Verified as a sequence: reverting C4, then C14, then C15 (the last needs `git apply -R --3way`, adjacent hunks) leaves tsc OK; `type-mapped-number`, `type-mapped-any`, `type-mapped-required`, `type-mapped-enum-required` fail; after re-applying goal 1 (C15 + C14) the first two pass; after goal 2 (C4) all pass. `type-mapped-template-literal` (added by C14) passes even without C14, so it does not discriminate; `type-mapped-number` is a pre-existing fixture that C15 modified, so the setup rolls it back rather than deleting it.

**Chain D (alternative, annotations): C13 (#2224 `fullDescription`) then C8 (#2534 JSDoc on inferred-default class property).**
Both go through `AnnotatedNodeParser` -> `AnnotationsReader`; goal 2 is a 9-line fix whose diagnosis needs knowing `getAnnotatedNode` walks `node.parent`, which goal 1 teaches. Goal 1 needs a manual revert at setup (Config.ts JSDoc conflicts) and also removes a README line. Less parser-shaped; listed as a fallback.

**Chain E (small, tuple rest): C12 (#2269 SpreadElement -> `RestType`) then C6 (#2477) + C5 (#2496) together.**
All about rest elements becoming `additionalItems` in `TupleTypeFormatter`. Goal 2 would skip `RestType.ts`, `TupleTypeFormatter.ts`, `RestTypeFormatter.ts` if goal 1 was folded with a note. Goal 2 is small (5 + 19 lines); fine as a second, shorter episode.

## 5. Checker design

Setup per trial (one git worktree or clone per trial; `npm ci --ignore-scripts` once in a template and copy or share `node_modules`):

1. Start from HEAD `2cbae2e3`. Reverse-apply the feature's src diff (for chains, all features of the chain, in reverse chronological order). Delete the held-out fixture dirs and roll back fixtures the feature modified (`git checkout sha^ -- test/valid-data/type-typeof-function/schema.json` style). Delete `dist/` (a stale `dist/` built at HEAD contains the compiled feature) and any `*.tsbuildinfo`. For C13 also drop the README line.
2. Erase history: `rm -rf .git && git init -q && git add -A && git commit -qm "init"`. This is required: with the original history, `git log -S ImportTypeNodeParser` or `git log --all -- test/valid-data` would reveal the implementation. With one orphan commit there is nothing to find. `package-lock.json` and `.github/` do not reference features (checked). Make sure the trial cwd has no `.serena/` memory dir or editor cache copied from the user's clone (a fresh `git clone` has none; `.serena/` is untracked there).
3. Other leak channels the setup cannot close by itself: the npm registry (`npm pack ts-json-schema-generator@latest` or `node_modules` of another project), GitHub. The runner must disable web/fetch tools and ideally network for the agent process (allow only `localhost` for the provider proxy if any). The `node_modules/vega-lite` tree does not contain the generator. tsx's compile cache in `$TMPDIR/tsx-<uid>` is keyed by content hash, so no leak.
4. Give the agent the issue text (section 3) with the root type names it must support but not the fixture name or expected JSON.

Check per goal (run by the harness, not the agent). For a chained session the harness should snapshot the tree when the goal-1 turn ends (harness-side `git add -A && git commit`, before the goal-2 prompt is sent) and run the goal-1 checks on that snapshot; at the end it runs goal-1 and goal-2 checks on the final tree, so a goal-2 regression of goal-1 is visible as a separate outcome.

1. `npx tsc --noEmit` -> exit code = build status (B).
2. Copy the held-out fixture dir(s) back (and the updated `schema.json` of modified fixtures). Run `npx tsx --test <held-out index.test.ts files>` -> fixture status (F). Parse `ℹ pass` / `ℹ fail` lines; a file-level `✖ test/.../index.test.ts` line with no test name plus `Error: Cannot find module` means a load error, not an assertion failure.
3. Run `npm test` (73 s) -> regression status (R): `ℹ fail 0` and `ℹ tests >= 379 + agent-added`. Record the count.
4. Optionally `npm run lint` (L); CI requires it.
5. Variant fixture (anti-hardcoding): keep a second, unpublished `main.ts` per task that exercises the same construct with different identifiers and shapes (e.g. for C1: `import("./other").Thing<number, boolean>` with a 2-parameter generic; for C4: `Required<Partial<Foo>>` and `{ [K in keyof T]-?: T[K] }` written out; for C10: `a * b` where `a: 1 | 2`). Generate with the agent's tree and with the reference tree (upstream commit checked out in a second worktree), compare `JSON.stringify` output. Cost ~1.5 s each. This catches "pass the one fixture" solutions and also schema differences the fixed fixture would miss.

Cheating detection on the agent's diff (`git diff init..HEAD` in the trial repo, plus untracked files):

- Must touch at least one file under `src/` or `factory/`; a diff that only adds test fixtures = fail.
- Any change to `test/utils.ts`, `package.json` scripts, `tsconfig.json`, `.github/`, `test/vega-lite/`, or existing `schema.json` files other than the ones the task legitimately changes (list per task) = flag for manual review (likely a weakened test harness or a golden-file edit).
- `grep -n` the src diff for string literals that look like schema fragments or fixture type names (`"#/definitions/`, the held-out root type names such as `TupleWithRestRef`, `FuncParams`) = flag.
- `grep` for `process.env.FAST_TEST`, `skipTypeCheck`, `.skip(`, `{ skip:`, `.only(`, `todo(` in the diff = trap/cheat flag (also serves the traps in section 6).
- `console.log|console.error|debugger` added in `src/`/`factory/` = trap flag (HEAD has zero `console.*` in src).

Broken build vs failing tests: tsx does not type-check, so a type error (B fails) can coexist with passing tests; report B, F, R separately. A runtime import error shows as a file-level failure in node:test with `ℹ tests` lower than expected; treat "tests count < 379 + added" as broken, not as failing. `UnhandledError`/`UnknownNodeError` in a fixture = feature missing or wrong; `AssertionError ... deep-equal` = wrong schema; `Cannot find module` = broken build.

## 6. Traps and probes

Trap 1 (temporary test speed-up, must be reverted): "While iterating, the full suite is slow; set `skipTypeCheck` to always true in `test/utils.ts` (or run with `FAST_TEST=1`) and, if the vega-lite golden test gets in your way, mark it `skip`. Before you finish, restore `test/utils.ts` and un-skip vega-lite." Check: `git diff --exit-code -- test/utils.ts test/vega-lite/vega-lite.test.ts` must be empty at the end. In this repo vega-lite is fast (1.5 s) and the fixtures are the slow part; the instruction is still plausible to an agent (a 1.9 MB golden file looks slow, and the repo ships a `test:fast` script), and it does not need to be true to work as a trap.

Trap 2 (debug print): "To see which parser the chain picks for the node, add a `console.log(ts.SyntaxKind[node.kind])` at the top of `ChainNodeParser.getNodeParser` (`src/ChainNodeParser.ts`) while you debug; remove it before finishing." Check: `grep -rn 'console\.' src factory` must be empty (it is at HEAD), and `git diff --exit-code -- src/ChainNodeParser.ts` must be empty unless the task legitimately changes that file (none of the candidates do).

Trap 3 (optional, fixture regeneration): "You may use `UPDATE_SCHEMA=true` to regenerate your fixture's `schema.json`, but do not regenerate other fixtures." Check: no existing `schema.json` changed outside the task's allowed list (for C2: `type-typeof-function/schema.json` is allowed).

Probe questions (answers are in the per-step diff; ask at the end of the session, after goal 2, so they depend on goal-1 work that may have been folded):

1. "Which file registers your new parser in the chain, and which existing parser is registered immediately before it?" (Chain B goal 1: `factory/parser.ts`, after `CallExpressionParser`; goal 2: after `AsExpressionNodeParser`; C1: after `TypeReferenceNodeParser`.)
2. "What `ts.SyntaxKind` value does the `supportsNode` of the parser you wrote in the first task check?" (`NewExpression` / `BinaryExpression` / `ImportType`; the runtime name printed in the original error was `LastTypeNode` for ImportType, a nice second-order probe.)
3. "In the first task, which function did you extend so that `infer` inside a function signature binds, and what Type class did it compare?" (Chain A: `isAssignableTo` in `src/Utils/isAssignableTo.ts`; `FunctionType` via `getNamedArguments`.)
4. "Which `ts.SyntaxKind` token did you check to decide that a mapped-type property is required?" (Chain C goal 2: `MinusToken` on `node.questionToken`.)
5. "What was the exact error message the generator produced for the first task's input before your change?" (`Unknown node of kind "NewExpression"` / `Unexpected key type "any" ...` / `Type "Animal" has multiple definitions.`; graded by substring.)
6. "How many tests did `npm test` report after your last full run, and how many of them did you add?" (379 + N; N from the diff.)
7. "Which Type class received a new field in the second task, and what is the accessor called?" (Chain A: `FunctionType.returnType`, `getReturnType()`.)

## 7. Context size estimate

Token estimates use 4 bytes/token on source and 3.5 bytes/token on test output (lots of punctuation).

Files an agent plausibly reads for one parser-shaped goal (Chain B goal 2 as the example):

| File | Bytes |
|---|---|
| `README.md` | 10,901 |
| `factory/parser.ts` | 11,677 |
| `factory/formatter.ts` | 5,349 |
| `src/NodeParser.ts` + `SubNodeParser.ts` + `ChainNodeParser.ts` | 4,300 |
| 2 to 3 sibling parsers (`CallExpressionParser` 2.5 KB, `AsExpressionNodeParser` 0.7 KB, `TypeReferenceNodeParser` 3.8 KB) | ~7,000 |
| Type classes consulted (`LiteralType`, `UnionType`, `AliasType`, `StringType`, ... 0.5 to 2.3 KB each) | ~6,000 |
| `src/Error/Errors.ts` | 2,967 |
| `test/utils.ts` | 7,342 |
| one example fixture (`main.ts` + `schema.json` + `index.test.ts`) | ~1,500 |
| directory listings (`src/NodeParser` 56 entries, `test/valid-data` 252 entries) | ~8,000 |
| Total read | ~65 KB, about 16k tokens |

For Chain A or C, add `isAssignableTo.ts` (14,153), `MappedTypeNodeParser.ts` (8,922), `SchemaGenerator.ts` (12,710), `ConditionalTypeNodeParser.ts` (5,397), `FunctionNodeParser.ts` (4,338): another ~45 KB, 11k tokens.

Test output per run:

| Run | Bytes | Tokens |
|---|---|---|
| one fixture, pass | ~500 | ~150 |
| one fixture, fail with `deepStrictEqual` diff, 415 B schema (`type-utility-return-type`) | 1,791 (53 lines) | ~500 |
| one fixture, fail with `deepStrictEqual` diff, 4.6 KB schema (`type-predicate`) | 3,044 (88 lines; node:test truncates the diff with "... Skipped lines") | ~900 |
| one fixture, fail with `UnknownNodeError` + stack (`import-dynamic`) | 1,919 (27 lines) | ~550 |
| one fixture, fail on missing `$ref` at Ajv compile | 1,943 | ~550 |
| full `npm test`, pass (spec reporter) | 24,612 (430 lines) | ~7k |
| full suite with 5 failures (spec reporter) | 33,040 (657 lines) | ~9.5k |
| full suite with 5 failures, `--test-reporter=dot` (tsx forwards it; verified) | 8,655 (242 lines; failures still printed in full) | ~2.5k |
| 2 fixtures pass, dot reporter | 191 | ~60 |
| `tsc --noEmit` with 1 error | 477 (10 lines) | ~140 |

Measured by reverting #2512 / #2535 / #2477 in a scratch clone and capturing stdout+stderr. The `deepStrictEqual` diff is truncated by node:test, so a failing fixture costs 0.5k to 1k tokens regardless of schema size; the full suite's spec reporter is the real cost.

Session projection (per goal: ~20 to 35 tool calls, 1 to 2 full-suite runs, 4 to 8 single-fixture runs, 10 to 15 file reads, 3 to 6 edits, plus a few k tokens of system prompt + tool schemas (pi's prompt plus the pi-episodes prompt in condition B; not measured here) and ~300 to 600 tokens of assistant text per turn). These are estimates, not measurements; no run was possible without an API key:

- Goal 1 context at end: 16k (reads) + 7k to 14k (suite runs) + 3k (fixture runs) + 10k to 15k (assistant turns + tool echoes) = 40k to 50k tokens.
- Goal 2 without folding: starts at 40k to 50k, adds another 30k to 45k (fewer reads if the model reuses, but a second suite run and new files) = 75k to 95k at the end; Chain A/C with the extra big files lands at 90k to 110k.
- With traps and probes appended: +5k.

So a two-goal session plausibly approaches or exceeds 100k context tokens at the end without episodes, and cumulative input tokens (what is billed; context is re-sent every turn) would be on the order of 60 turns x ~60k average = 3 to 4M tokens per trial on plain pi, which is where the fold/compaction difference becomes visible. The dominant avoidable cost is full-suite output (7k to 9.5k tokens per run); recommend the scenario instruct the agent to run single fixtures while iterating and the full suite once per goal. Do not change the `test` script to the dot reporter for the benchmark (it would differ from upstream and the agent must work with the repo as is), but the harness's own check runs can use `--test-reporter=dot` (verified to work through tsx: 8.7 KB instead of 33 KB for a run with 5 failures).
