# Report Format

この文書は SpecQR Conformance Lab が公開する machine-readable data format をまとめます。JSON Schema は draft 2020-12 で書き、`schemas/` に置きます。

## Schema files

| Format | Schema | Primary files |
| --- | --- | --- |
| Vector suite v1 | [../schemas/vector-suite-v1.schema.json](../schemas/vector-suite-v1.schema.json) | `vectors/*.json` |
| Conformance report v1 | [../schemas/conformance-report-v1.schema.json](../schemas/conformance-report-v1.schema.json) | `reports/latest.json`, filtered report artifacts |
| Badge v1 | [../schemas/badge-v1.schema.json](../schemas/badge-v1.schema.json) | `badges/*.json` |
| Report comparison v1 | [../schemas/report-comparison-v1.schema.json](../schemas/report-comparison-v1.schema.json) | `reports/comparison.json` |

`npm run validate:schemas` は現行の vector suite、latest report、badge file、report self-comparison を schema validation します。`reports/comparison.json` が存在する場合は、その comparison output も検査します。

## Conformance report

report schema は `reports/latest.json` の安定 field を定義します。top-level には `schemaVersion`, `labVersion`, `status`, `metadata`, `run`, `target`, `adapters`, `suites`, `summary`, `results` を持ちます。

`target.requested` は requested npm package spec、`target.resolvedVersion` は実際に installed package から読んだ version、`target.source` は package source を表します。`summary` は total count、adapter summary、GS1 / DL、Structured Append、Planning / Diagnostics、Kanji / ECI / binary、Rendering / Output の主要 scope summary を持ちます。

filtered run は full run と同じ schema です。filter 条件は `run.mode: "filtered"` と `run.filters.suites`, `run.filters.categories`, `run.filters.adapters`, `run.filters.vectors` に記録します。full run は `run.mode: "full"` です。

## Badge

badge schema は Shields-compatible JSON endpoint として使う最小形式です。`schemaVersion: 1`, `label`, `message`, `color` を必須にします。現行の color は `green`, `yellow`, `red` です。

badge は report の結果を短く表す derived artifact です。scope skip は failure とは別に扱い、failed/error がある場合だけ red、実行 check がなく skip だけの場合は yellow、それ以外は green になります。

## Report comparison

comparison schema は `tools/compare-reports.js` の JSON output を定義します。`base` と `candidate` の target/summary、target metadata delta、summary count delta、adapter summary delta、主要 suite summary delta、vector/adapter status change、failed/error に関わる check-level change、regression list を持ちます。

default の comparison は count difference だけで失敗しません。`--fail-on-regression` を使う CLI 実行では、新しい failed/error result または required adapter の passed check 喪失がある場合に nonzero exit になります。JSON output では `hasRegression` と `regressions` を見れば機械的に判定できます。

## Compatibility policy

v1 schema は既存 consumer が依存してよい stable required field と enum を固定します。一方で、diagnostics、adapter details、result details、summary の追加情報は発展する余地があるため、原則として additive field を許可します。

互換な変更:

- object に optional field を追加する。
- `details` や diagnostics subset に追加情報を入れる。
- docs で未解釈 field として扱える metadata を追加する。

互換でない変更:

- required field を削除または rename する。
- stable enum value の意味を変える。
- count field の型を number/integer 以外へ変える。
- `schemaVersion: 1` のまま別形式の payload にする。

breaking change が必要な場合は、新しい schema file と `schemaVersion` を追加し、v1 consumer が v1 を読み続けられる期間を設けます。
