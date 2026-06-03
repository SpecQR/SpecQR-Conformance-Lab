# Development Policy

この文書は contributor 向けの実装方針です。利用者向けの概要は [README.md](../README.md) を参照してください。

## 独立性

この lab は npm に公開された `specqr@2.4.0` を外部からブラックボックス検証します。SpecQR core repository の source tree や contributor の local checkout には依存しません。

adapter や tool は、検証対象の SpecQR 実装を変更せず、生成結果、decoder 結果、reference comparison、helper API の結果を外部から記録します。

## 実装ルール

- SpecQR adapter は published package の公開 API だけを使う。
- local machine 固有の絶対 path、user name、作業環境名を docs、reports、badge、test fixture に入れない。
- generated report と Pages artifact は `npm run conformance`, `npm run report`, `npm run pages:build` で再生成できる状態を保つ。
- expected scope skip は隠さず report に残し、failure / error とは区別する。
- npm release、GitHub release、version tag は conformance lab の publish workflow とは別に扱う。

## Filtered Runs

開発中に 1 suite、1 adapter、1 vector だけを確認したい場合は filtered conformance run を使えます。たとえば `npm run conformance -- --suite kanji-eci-binary --output reports/kanji.local.json` や `npm run conformance -- --adapter specqr --output reports/specqr.local.json` は局所的な確認に向いています。

filtered run は作業中の feedback を速くするための道具です。merge / push 前の判断は full `npm run verify` を正本にします。`npm run verify` は full conformance report を生成し、`npm run verify:report` で summary と result coverage の整合性を確認します。

filtered report を共有する場合は `run.mode` と `run.filters` を確認し、full report と取り違えないようにします。repository に残す generated report は、明示的な理由がない限り full run の `reports/latest.json` / `reports/latest.html` にします。
