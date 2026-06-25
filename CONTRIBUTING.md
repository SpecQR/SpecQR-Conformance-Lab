# Contributing

SpecQR Conformance Lab は、公開 npm package と外部 adapter を black-box に近い形で検証する repository です。SpecQR core の実装変更や local checkout への依存は、この repository の範囲外です。

## Documentation style

公開文書は Japanese-main で書きます。見出しや command name、schema field、adapter ID、workflow 名は英語のままで構いません。日本語本文では、何を検証しているか、何を検証していないか、failure と expected skip の違いを明確に書きます。

## Add vectors

vector は `vectors/*.json` に suite 単位で追加します。まず [docs/vector-schema.md](docs/vector-schema.md) と [schemas/vector-suite-v1.schema.json](schemas/vector-suite-v1.schema.json) を確認してください。

- `suite.version` は `1` のままにする。
- `vector.id` は repository 全体で一意にする。
- `operation` は schema と `tools/validate-vectors.js` の enum にある値を使う。
- `input`, `options`, `expect` は必ず object にする。
- binary payload は偶数長 hex の `binaryHex` として書く。
- negative / reject case は `expect.rejects` または `expect.validation` を明示する。

vector 追加後は少なくとも `npm run validate:vectors`, `npm test`, `npm run conformance`, `npm run report`, `npm run validate:schemas`, `npm run verify:report` を実行します。広い変更では `npm run verify` まで通します。

## Add adapters

adapter は `adapters/` に追加し、`tools/run-conformance.js` の adapter list と summary/report surface に接続します。新しい adapter は次を満たしてください。

- SpecQR core source file を import しない。
- npm package、CLI command、または documented public API だけを使う。
- 未対応 operation は理由付き `skipped` として返す。
- optional native/CLI tool は missing command を failure にしない。
- 実行した check が期待値と不一致なら `failed` または `error` として返す。
- report の `checks[]` に、人間と機械が判断できる stable `name` と `status` を入れる。

## Skip and failure semantics

`skipped` は、その adapter の範囲外、または optional tool が存在しないことを表します。expected skip は CI failure ではありません。

`failed` は、adapter が実行できたにもかかわらず期待値と違ったことを表します。`error` は、adapter 実行中の例外や環境異常など、判定不能な実行失敗を表します。required adapter の `failed` / `error` は release-readiness 上の blocker です。

## Required checks

通常の変更では次を確認します。

```sh
npm run validate:vectors
npm test
npm run conformance
npm run report
npm run validate:schemas
npm run verify:report
npm run pages:build
npm run verify
```

target version の比較を確認する場合は次も実行します。

```sh
npm run compare:reports -- --base reports/latest.json --candidate reports/latest.json --json-output reports/comparison.json
```

## SpecQR core boundary

この repository は `/src` や local checkout の SpecQR core source を import しません。検証対象は published package と public package surface です。SpecQR core の修正が必要な finding は、core repository 側の issue / PR として扱います。

## Maintainer identity

maintainer が main branch に直接 commit / push する場合は、Author と Committer を SpecQR identity にそろえます。

Expected Git identity: `SpecQR <285361393+SpecQR@users.noreply.github.com>`

```sh
git config user.name "SpecQR"
git config user.email "285361393+SpecQR@users.noreply.github.com"
```

tag、release、npm publish は、この repository の通常作業では行いません。明示的な承認がある場合だけ、release readiness checklist を確認してから実施します。
