# Release Readiness

この文書は release / publish を検討する前の checklist です。現時点では release、tag、npm publish は行いません。SpecQR Conformance Lab は private npm package のまま、public Pages と GitHub Actions artifact を運用対象にします。

## Pre-release checklist

- Verify workflow が Node 18 / 20 / 22 / 24 で green。
- Pages workflow が green。
- public report が到達可能: `https://specqr.github.io/SpecQR-Conformance-Lab/reports/latest.json`
- public schema URL が到達可能:
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/vector-suite-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/conformance-report-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/badge-v1.schema.json`
  - `https://specqr.github.io/SpecQR-Conformance-Lab/schemas/report-comparison-v1.schema.json`
- `reports/latest.json` に required adapter の `failed` / `error` result がない。
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
npm run verify:report
npm run pages:build
npm run verify
```

## What is not a release claim

manual target workflow の `specqr@latest` / `specqr@next` comparison artifact は investigation output です。public Pages report は pinned baseline の snapshot であり、candidate target の release claim ではありません。

filtered conformance artifact も investigation output です。full baseline と同じ schema を使いますが、`run.mode: "filtered"` と `run.filters` を見て scope を判断します。
