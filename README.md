# SpecQR Conformance Lab

SpecQR Conformance Lab は、SpecQR を外部から検証するための conformance / comparison / report 基盤です。この lab は npm に公開された `specqr@2.4.0` を外部からブラックボックス検証します。

SpecQR core repository の source tree や local checkout には依存しません。検証対象の SpecQR 実装を変更せず、生成結果、decoder 結果、reference comparison、helper API の結果を外部から記録します。

## 目的

- QR Code Model 2 の挙動を確認する machine-readable vector を管理する。
- 公開済み SpecQR と他の JavaScript QR 実装を同じ vector で比較できるようにする。
- `reports/latest.json` と `reports/latest.html` を安定して生成する。
- SpecQR core の開発とは切り離した外部検証の流れを作る。

## 非目標

- SpecQR core の実装変更はこの repository の範囲外です。
- full QR reader は実装しない。
- Micro QR / rMQR は対象にしない。
- GS1 の全 catalog は持たない。
- この段階では optional zbar/ZXing lane や release/publish work は実装しない。

contributor 向けの実装制約は [docs/development-policy.md](docs/development-policy.md) にまとめています。

## Vector Schema

vector schema v1 は [docs/vector-schema.md](docs/vector-schema.md) に定義しています。suite は `version`, `id`, `name`, `description`, `category`, `vectors` を持ち、各 vector は `id`, `title`, `category`, `operation`, `input`, `options`, `expect` を必須 field とします。

`operation` は QR generation、manual segments、Planning API、GS1 / Digital Link helper、Structured Append helper を表せる enum です。adapter 実装者はこの schema を先に読めば、どの入力をどの API に渡し、どの期待値を比較すべきか分かる状態を目指します。

## 最初に予定している Adapter

- SpecQR: 公開 npm package `specqr@2.4.0` を対象にする。現在は `generate`, `generateSegments`, Planning / Diagnostics API、SpecQR がサポートする GS1 / Digital Link helper subset、Structured Append helper の確認に対応している。
- jsQR: SpecQR が生成した PNG を読み、`expect.decode` の text / raw byte readability を検証する active decoder lane。
- Nayuki: 固定 Version/ECC/mask 条件で `expect.referenceMatrix` の exact matrix match を確認する active reference lane。

decode expectation は jsQR lane で実行します。jsQR が raw byte を公開できない場合だけ、binary decode check を制限として `skipped` にします。jsQR lane は Planning API や Structured Append metadata validation、decoder merge support を主張しません。Nayuki lane は固定条件だけを扱い、Planning API、GS1、Kanji、Structured Append、renderer output、auto segmentation の同等性は主張しません。

## Reports

最初の report target は次の 2 つです。

- `reports/latest.json`: machine-readable な conformance report。
- `reports/latest.html`: 人間がざっと確認するための summary。

`npm run conformance` は `reports/latest.json` を生成します。JSON には `generatedAt`、Node version、platform/arch、`specqr` / `jsqr` / `nayuki-qr-code-generator` の installed package version を含めます。

`npm run report` は `reports/latest.html` と Shields-compatible な badge JSON を生成します。badge は scope skip を失敗とは別に扱い、失敗またはエラーがある場合だけ red、実行 check がなく skip だけの場合は yellow、それ以外は green になります。

生成する badge file:

- `badges/overall.json`
- `badges/specqr.json`
- `badges/jsqr.json`
- `badges/nayuki.json`
- `badges/gs1-digital-link.json`
- `badges/structured-append.json`
- `badges/planning-diagnostics.json`

`npm run pages:build` は conformance と report を生成したあと、GitHub Pages 用の static artifact を `public/` に作ります。`public/index.html` は最新 HTML report、`public/reports/latest.json` は machine-readable report、`public/badges/*.json` は Shields badge endpoint 用の file です。

`.github/workflows/pages.yml` は `main` branch への push で `npm ci`、`npm run verify`、`npm run pages:build` を実行し、`public/` を GitHub Pages artifact として upload/deploy します。

## Commands

```sh
npm test
npm run validate:vectors
npm run conformance
npm run report
npm run pages:build
npm run verify
```

`npm run verify` は vector validation、focused test、SpecQR/jsQR/Nayuki conformance、report generation を順に実行します。Pages artifact の生成は `npm run pages:build` で行います。

## 現在の状態

この repository は schema v1、SpecQR baseline adapter、jsQR decoder lane、Nayuki fixed-condition matrix reference lane を持つ conformance lab です。SpecQR adapter は published package を実行し、jsQR lane は生成 PNG の readability を確認し、Nayuki lane は固定 Version/ECC/mask の matrix exact match だけを確認します。
