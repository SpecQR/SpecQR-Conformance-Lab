# Release Readiness

この文書は release / publish を検討する前の checklist です。現時点では release、tag、npm publish は行いません。SpecQR Conformance Lab は private npm package のまま、public Pages と GitHub Actions artifact を運用対象にします。

## Pre-release checklist

- Verify workflow が Node 18 / 20 / 22 / 24 で green。
- Pages workflow が green。
- public report が到達可能: `https://specqr.github.io/SpecQR-Conformance-Lab/reports/latest.json`
- public HTML explorer が到達可能で、suite / category / adapter / status / vector id search の filter controls と result detail `<details>` を含む: `https://specqr.github.io/SpecQR-Conformance-Lab/reports/latest.html`
- public schema URL が到達可能:
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/vector-suite-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/conformance-report-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/badge-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/report-comparison-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/coverage-claims-v1.schema.json`
- public coverage claims map が到達可能: `https://specqr.github.io/SpecQR-Conformance-Lab/coverage/claims-v1.json`
- `reports/latest.json` に required adapter の `failed` / `error` result がない。
- `npm run verify:claims` が green で、non-claim が vector / adapter / badge / report summary coverage を装っていない。
- optional decoder の expected skip が README と [docs/known-limits.md](known-limits.md) に書かれている。
- `package.json` は `"private": true` のまま。npm package release を意図する場合だけ変更を検討する。
- tag / GitHub release / npm publish は明示的に承認されている場合だけ実施する。
- SpecQR core link が有効: `https://github.com/SpecQR/SpecQR`
- `specqr` baseline pin と report target が意図した version を指している。
- issue templates、SECURITY、CONTRIBUTING、dependency policy が現行運用と矛盾していない。

## Required local checks

release-readiness を確認する変更では、少なくとも次を実行します。

```sh
npm run validate:vectors
npm test
npm run conformance
npm run report
npm run compare:reports -- --base reports/latest.json --candidate reports/latest.json --json-output reports/comparison.json
npm run validate:schemas
npm run verify:claims
npm run verify:report
npm run pages:build
npm run verify
```

## What is not a release claim

manual target workflow の `specqr@latest` / `specqr@next` comparison artifact は investigation output です。public Pages report は pinned baseline の snapshot であり、candidate target の release claim ではありません。

filtered conformance artifact も investigation output です。full baseline と同じ schema を使いますが、`run.mode: "filtered"` と `run.filters` を見て scope を判断します。

Published RC の dedicated evidence も stable release claim ではありません。[RC Validation](rc-validation.md) の `technicalStatus` が `pass` でも、独立した利用観察が十分になるまでは `observationStatus` を `pending` とし、public `specqr@2.4.0` report、badges、Pages、npm dist-tag を変更しません。

利用観察の必要期間、snapshot milestone、issue / PR review、独立 consumer confirmation、final technical rerun は [RC Observation](rc-observation.md) に従います。`observationStatus: "sufficient"` は stable go / no-go goal の入力であり、publish command ではありません。

Historical RC run `30739905031` は subject routing defect により失効しています。Fresh technical evidence、信頼できる observation timeline、独立 consumer confirmation が揃うまでは RC readiness の未完了条件を維持します。過去の window を現在の実行で補完しません。詳しくは [historical evidence revocation](rc-observation.md#historical-evidence-revocation) を参照してください。

## Correctness completion boundary

Lab の tooling 完成と、特定 RC の release 判断は別です。現在の acceptance は target routing の破損、偽の passed status、required check の欠落、matrix module / payload の変化を negative control で検出し、公開 baseline を再生成・検証できることです。[Reference provenance](reference-provenance.md) が独立 matrix 比較の具体的な範囲を定義します。

過去の RC technical evidence に target routing の欠陥があったため、run `30739905031` と該当 commit の evidence は再利用できません。新しい source での technical rerun、独立 consumer confirmation、policy に適合した observation timeline は別途必要です。過去の観察時刻を作り直さず、stable publish を自動許可しません。[RC observation](rc-observation.md) の説明を確認してください。
