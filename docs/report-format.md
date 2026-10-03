# Report Format

この文書は SpecQR Conformance Lab が公開する machine-readable data format をまとめます。JSON Schema は draft 2020-12 で書き、`schemas/` に置きます。

## Schema files

| Format | Schema | Primary files |
| --- | --- | --- |
| Vector suite v1 | [../schemas/vector-suite-v1.schema.json](../schemas/vector-suite-v1.schema.json) | `vectors/*.json` |
| Conformance report v1 | [../schemas/conformance-report-v1.schema.json](../schemas/conformance-report-v1.schema.json) | `reports/latest.json`, filtered report artifacts |
| Badge v1 | [../schemas/badge-v1.schema.json](../schemas/badge-v1.schema.json) | `badges/*.json` |
| Report comparison v1 | [../schemas/report-comparison-v1.schema.json](../schemas/report-comparison-v1.schema.json) | `reports/comparison.json` |
| Coverage claims v1 | [../schemas/coverage-claims-v1.schema.json](../schemas/coverage-claims-v1.schema.json) | `coverage/claims-v1.json` |
| RC readiness v1 | [../schemas/rc-readiness-v1.schema.json](../schemas/rc-readiness-v1.schema.json) | `reports/rc/readiness.json` in Actions artifacts |
| RC expected delta policy v1 | [../schemas/rc-expected-delta-policy-v1.schema.json](../schemas/rc-expected-delta-policy-v1.schema.json) | `policies/specqr-3.0.0-rc.2-expected-deltas-v1.json` |
| RC observation policy v1 | [../schemas/rc-observation-policy-v1.schema.json](../schemas/rc-observation-policy-v1.schema.json) | `policies/specqr-3.0.0-rc.2-observation-v1.json` |
| RC observation manual evidence v1 | [../schemas/rc-observation-manual-evidence-v1.schema.json](../schemas/rc-observation-manual-evidence-v1.schema.json) | `evidence/specqr-3.0.0-rc.2-observation-manual-v1.json` |
| RC observation report v1 | [../schemas/rc-observation-v1.schema.json](../schemas/rc-observation-v1.schema.json) | `reports/observation/current/observation.json` in Actions artifacts |

`npm run validate:schemas` は現行の vector suite、latest report、badge file、coverage claims、RC expected delta policy、RC observation policy / manual evidence、report self-comparison を schema validation します。`reports/comparison.json` が存在する場合は、その comparison output も検査します。

RC readiness は default public report と別 lifecycle です。`npm run rc:validate -- --report reports/rc/readiness.json` が schema と fixed target、registry hash、Node matrix、raw strict comparison、expected-delta adjudication、v3 contract、technical / observation status の semantic consistency を検査します。RC readiness schema と expected delta policy schema、generated evidence は default Pages artifact へ追加しません。

## Conformance report

report schema は `reports/latest.json` の安定 field を定義します。top-level には `schemaVersion`, `labVersion`, `status`, `metadata`, `run`, `target`, `adapters`, `suites`, `summary`, `results` を持ちます。

`target.requested` は requested npm package spec、`target.resolvedVersion` は実際に installed package から読んだ version、`target.source` は package source を表します。`summary` は total count、adapter summary、GS1 / DL、Structured Append、Planning / Diagnostics、Kanji / ECI / binary、Rendering / Output、Package Surface、Coverage claims の主要 scope summary を持ちます。

`summary.coverageClaims` は `coverage/claims-v1.json` から作る要約です。`claimCount`, `verified`, `partial`, `notClaimed`, `statusCounts`, `claims` を含み、report consumer が「何を検証済みと言い、何を claim していないか」を machine-readable に確認できます。

filtered run は full run と同じ schema です。filter 条件は `run.mode: "filtered"` と `run.filters.suites`, `run.filters.categories`, `run.filters.adapters`, `run.filters.vectors` に記録します。full run は `run.mode: "full"` です。

## HTML report explorer

`reports/latest.html` は `reports/latest.json` と `coverage/claims-v1.json` から生成する static view です。HTML 自体は schema で固定しませんが、public report として suite、category、adapter、status、vector id search の filter control、filter 後 count、result ごとの `<details>` detail block、coverage claims / non-claims の link table を持ちます。

JavaScript が無効な環境でも full result table を最初から表示します。filter は dependency-free な inline script だけで行い、conformance semantics や `reports/latest.json` の結果は変更しません。

## Badge

badge schema は Shields-compatible JSON endpoint として使う最小形式です。`schemaVersion: 1`, `label`, `message`, `color` を必須にします。現行の color は `green`, `yellow`, `red` です。

badge は report の結果を短く表す derived artifact です。scope skip は failure とは別に扱い、failed/error がある場合だけ red、実行 check がなく skip だけの場合は yellow、それ以外は green になります。

## Report comparison

comparison schema は `tools/compare-reports.js` の JSON output を定義します。`base` と `candidate` の target/summary、target metadata delta、summary count delta、adapter summary delta、主要 suite summary delta、vector/adapter status change、failed/error に関わる check-level change、regression list を持ちます。

default の comparison は count difference だけで失敗しません。`--fail-on-regression` を使う CLI 実行では、新しい failed/error result または required adapter の passed check 喪失がある場合に nonzero exit になります。JSON output では `hasRegression` と `regressions` を見れば機械的に判定できます。

## Coverage claims

`coverage/claims-v1.json` は Lab 全体の coverage claim map です。各 claim は `id`, `title`, `status`, `summary`, `suites`, `adapters`, `badges`, `reportSummaryKey`, `limits` を持ちます。`status` は `verified`, `partial`, `not-claimed` のいずれかです。

`not-claimed` entry は vector / adapter / badge / report summary coverage を参照しません。`npm run verify:claims` は schema validation に加えて、参照された suite が vectors と report の両方に存在すること、adapter が report に存在すること、badge file が存在すること、non-claim が passing vector coverage を装わないことを確認します。

## RC readiness

`reports/rc/readiness.json` は published RC の temporary evidence format です。Target、toolchain、registry integrity、adapter 別 conformance、raw strict regression、expected-delta adjudication、candidate 専用 contract、skip / non-claim、evidence file hash を 1 つに集約します。`expectedDelta` は policy path / SHA-256、exact / `next` ごとの raw delta count、matched / missing / unexpected、positive control、selector 一致を記録します。Validator は policy と schema の SHA-256、raw report からの adjudication、listed file の size / SHA-256、artifact set SHA-256 を再計算します。`technicalStatus` と `observationStatus` は独立 field です。Technical gate が green でも、利用観察が別条件を満たすまでは observation を `pending` とします。

## RC observation

`reports/observation/current/observation.json` は RC 公開後の時系列 evidence format です。Candidate、published / observed timestamp、age、technical evidence run、registry snapshot、GitHub issue / PR snapshot、manual classification、consumer confirmation、blocker、criteria、status、snapshot timeline、file hash を記録します。

`npm run observation:validate` は fixed policy / schema hash、candidate / dist-tag / artifact hash、technical readiness 内容、snapshot fingerprint、chronology、duplicate、future timestamp、manual evidence hash、listed file、manifest、artifact set hash、report 再組立を検査します。期間・snapshot・confirmation が不足した正当な `pending` report は validation success です。Registry drift、technical failure、open blocker、evidence 改変を含む `blocked` report は failure です。この format は default Pages artifact に追加しません。

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

## Evidence integrity and portable provenance

新しい report は optional な `semanticSha256` を持ちます。target、suite、adapter、summary、result/check を key 順に正規化した JSON の SHA-256 であり、生成時刻、runtime、出力先 path は対象外です。保存前後で同じ fingerprint になります。hash は改ざん検知の補助であり、署名や独立した認証ではありません。`verify:report` は hash だけでなく、vector identity、adapter inventory、check/result status、check 名の一意性、filter と run mode の整合性も検証します。

`metadata.provenance` は Lab commit と dirty flag、実行 source / vector / lockfile fingerprint、実際に読み込んだ package の version / content SHA-256 / lock integrity を記録します。package content hash は相対 file path と各 file SHA-256 の sorted manifest から計算し、絶対 path は保存しません。temporary candidate package に baseline lock integrity は流用しません。`subjectRouting` revision 1 は全生成 lane が共有 target resolver を使う契約です。metadata だけ別 package に差し替える指定は拒否します。

Coverage claim の `evidenceRequirements` は adapter ごとの versioned capability を列挙します（non-claim は空配列）。`verified` と `partial` の両方について、source vector から導く適用対象 check がすべて pass したことを必要とします。1 件の pass だけでは、別 vector や decoder の missing / failed / skipped check を埋め合わせられません。optional CLI の unavailable は別集計し、pass に数えません。

native decoder の raw stdout / stderr と一時 path は公開しません。exit / signal、出力 byte 数、確認できる version、期待値と一致した payload を記録します。不一致または未検証 payload は SHA-256 と byte 数だけを残し、比較は redaction 前の生値で行います。version probe が version を返さない場合は `null` / `unknown` です。

`npm run verify:public` は再生成後の full pinned baseline、report / coverage evidence、公開 file の machine path / credential 混入を検査します。Pages build は badge と coverage の明示した file だけをコピーし、無関係な local JSON や RC observation schema を公開しません。

`vectorsSha256` は disk 上の全 vector corpus の fingerprint です。filtered run や RC の正規化後 suite そのものとは区別します。RC の `scopeSha256` は実行する正規化済み vector と adapter ID を対象にし、`semanticSha256` は実際に得た report result を対象にします。
