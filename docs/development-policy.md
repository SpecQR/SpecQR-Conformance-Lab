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
