# SpecQR Conformance Lab

SpecQR Conformance Lab は、SpecQR を外部から検証するための conformance / comparison / report 基盤です。この lab は npm に公開された `specqr@2.4.0` を外部からブラックボックス検証します。

SpecQR core repository の source tree や local checkout には依存しません。検証対象の SpecQR 実装を変更せず、生成結果、decoder 結果、reference comparison、helper API の結果を外部から記録します。

## 目的

- QR Code Model 2 の挙動を確認する machine-readable vector を管理する。
- 公開済み SpecQR と他の JavaScript QR 実装を同じ vector で比較できるようにする。
- `reports/latest.json` と `reports/latest.html` を安定して生成する。
- SpecQR core の開発とは切り離した外部検証の流れを作る。
- Kanji mode、ECI UTF-8、raw binary payload の representative vector を外部から確認する。

## 非目標

- SpecQR core の実装変更はこの repository の範囲外です。
- full QR reader は実装しない。
- Micro QR / rMQR は対象にしない。
- GS1 の全 catalog は持たない。
- zbarimg / ZXing CLI などの native tool を必須 dependency にはしない。
- scanner metadata や Structured Append decoder merge support は実装しない。

contributor 向けの実装制約は [docs/development-policy.md](docs/development-policy.md) にまとめています。

## Vector Schema

vector schema v1 は [docs/vector-schema.md](docs/vector-schema.md) に定義しています。suite は `version`, `id`, `name`, `description`, `category`, `vectors` を持ち、各 vector は `id`, `title`, `category`, `operation`, `input`, `options`, `expect` を必須 field とします。

`operation` は QR generation、manual segments、Planning API、GS1 / Digital Link helper、Structured Append helper を表せる enum です。adapter 実装者はこの schema を先に読めば、どの入力をどの API に渡し、どの期待値を比較すべきか分かる状態を目指します。

## 最初に予定している Adapter

- SpecQR: 公開 npm package `specqr@2.4.0` を対象にする。現在は `generate`, `generateSegments`, Planning / Diagnostics API、SpecQR がサポートする GS1 / Digital Link helper subset、Structured Append helper の確認に対応している。
- jsQR: SpecQR が生成した PNG を読み、`expect.decode` の text / raw byte readability を検証する active decoder lane。
- Nayuki: 固定 Version/ECC/mask 条件で `expect.referenceMatrix` の exact matrix match を確認する active reference lane。
- zbarimg: `zbarimg` command がある環境だけで実行する optional decoder readability lane。
- ZXing CLI: `ZXingReader`, `zxing`, `zxing-cpp`, `zxingscan` のいずれかがある環境だけで実行する optional decoder readability lane。

decode expectation は jsQR lane で実行します。jsQR が raw byte を公開できない場合だけ、binary decode check を制限として `skipped` にします。jsQR lane は Planning API や Structured Append metadata validation、decoder merge support を主張しません。Nayuki lane は固定条件だけを扱い、Planning API、GS1、Kanji、Structured Append、renderer output、auto segmentation の同等性は主張しません。

Kanji / ECI / binary suite は、auto Kanji、forced Kanji、manual Kanji segment、UTF-8 byte fallback、ECI UTF-8、manual ECI segment、raw byte payload、negative reject case を扱います。ECI metadata や scanner metadata の full reader conformance は主張せず、reader lane では text / raw-byte readability として観測できる範囲だけを確認します。

optional decoder lane は CLI command が見つからない場合、clear reason 付きの expected `skipped` として記録します。missing `zbarimg` / ZXing CLI は CI failure ではありません。command が見つかり、`expect.decode.text` と異なる payload を返した場合は failure として扱います。CLI 出力だけでは raw byte を安定して扱えないため、`expect.decode.binaryHex` は optional CLI lane では制限として `skipped` にします。

## Reports

最初の report target は次の 2 つです。

- `reports/latest.json`: machine-readable な conformance report。
- `reports/latest.html`: 人間がざっと確認するための summary。

`npm run conformance` は `reports/latest.json` を生成します。JSON には `generatedAt`、Node version、platform/arch、`specqr` / `jsqr` / `nayuki-qr-code-generator` の installed package version を含めます。`target.requested` は requested package spec、`target.resolvedVersion` は実際に `node_modules/specqr/package.json` から読んだ installed version、`target.source` は package source を表します。通常の full run は pinned dependency の `specqr@2.4.0` を requested target として記録します。

default の conformance run は unfiltered full run として記録されます。`--suite`, `--category`, `--adapter`, `--vector`, `--output` を使うと filtered run を作れます。filtered run は `reports/latest.json` の `run.mode` と `run.filters` に記録されます。

`npm run report` は `reports/latest.html` と Shields-compatible な badge JSON を生成します。badge は scope skip を失敗とは別に扱い、失敗またはエラーがある場合だけ red、実行 check がなく skip だけの場合は yellow、それ以外は green になります。

生成する badge file:

- `badges/overall.json`
- `badges/specqr.json`
- `badges/jsqr.json`
- `badges/nayuki.json`
- `badges/zbarimg.json`
- `badges/zxing-cli.json`
- `badges/kanji-eci-binary.json`
- `badges/gs1-digital-link.json`
- `badges/structured-append.json`
- `badges/planning-diagnostics.json`

`npm run pages:build` は conformance と report を生成したあと、GitHub Pages 用の static artifact を `public/` に作ります。`public/index.html` は最新 HTML report、`public/reports/latest.json` は machine-readable report、`public/badges/*.json` は Shields badge endpoint 用の file です。

`.github/workflows/pages.yml` は `main` branch への push で `npm ci`、`npm run verify`、`npm run pages:build` を実行し、`public/` を GitHub Pages artifact として upload/deploy します。

## CI summary / artifacts

`npm run summary` は生成済み `reports/latest.json` から GitHub Step Summary 用の Markdown を出力します。通常の stdout にも同じ内容を出すため、local でも CI log でも target package、vector / result 件数、adapter 別結果、GS1 / DL、Structured Append、Planning / Diagnostics、Kanji / ECI / binary の主要 scope、optional decoder availability を確認できます。

`.github/workflows/verify.yml` は Node 18 / 20 / 22 / 24 の matrix で `npm ci` と `npm run verify` を実行し、各 job の Summary に conformance summary を表示します。毎回 `reports/latest.json`、`reports/latest.html`、`badges/*.json` を upload し、artifact 名は `conformance-report-node-22` のように Node version を含みます。

`.github/workflows/pages.yml` は `main` push / manual dispatch だけで Pages deploy を行います。`npm run pages:build` のあとに `npm run summary` を実行し、PR からの deploy は行いません。公開 Pages は `https://specqr.github.io/SpecQR-Conformance-Lab/` を想定します。

`.github/workflows/conformance-filtered.yml` は Actions UI から手動で filtered run を起動する workflow です。`suite`、`category`、`adapter`、`vector` を任意入力でき、空欄は filter なしとして扱います。この workflow も `reports/latest.json`、`reports/latest.html`、`badges/*.json` を filtered conformance artifact として upload します。

`.github/workflows/specqr-target.yml` は Actions UI から手動で SpecQR npm package spec を差し替えて実行する調査 workflow です。`package_spec` には `specqr@2.4.0`、`specqr@latest`、`specqr@next` などを指定でき、`node_version` の default は `22` です。この workflow は `npm ci` のあと `npm install --no-save --package-lock=false "$PACKAGE_SPEC"` で requested package だけを一時的に入れ替え、`package.json` と `package-lock.json` が変わっていないことを確認してから conformance / report / summary を実行します。

公開 Pages report は通常 CI が pinned dependency `specqr@2.4.0` で生成した report です。`specqr-target.yml` の結果は workflow artifact として確認する investigation artifact であり、Pages deploy も release claim も行いません。`latest` や `next` の結果は通常 release gate には含めません。

## Commands

```sh
npm test
npm run validate:vectors
npm run conformance
npm run report
npm run verify:report
npm run verify:target
npm run summary
npm run pages:build
npm run verify
```

よく使う runner command:

```sh
# 全 suite / 全 adapter を実行して reports/latest.json を更新する
npm run conformance

# suite と adapter を一覧する
npm run conformance -- --list-suites
npm run conformance -- --list-adapters

# 1 suite だけを一時 report に出す
npm run conformance -- --suite kanji-eci-binary --output reports/kanji-eci-binary.local.json

# 1 adapter だけを実行する
npm run conformance -- --adapter specqr --output reports/specqr.local.json

# 1 vector だけを全 adapter で実行する
npm run conformance -- --vector core.generate.byte-text --output reports/vector.local.json
```

`npm run verify:report` は生成済み `reports/latest.json` の summary / adapter summary / suite count / result coverage を検査します。`npm run verify` は vector validation、focused test、SpecQR/jsQR/Nayuki と optional CLI decoder の conformance、report generation、report integrity validation を順に実行します。optional CLI decoder command がない環境では、その lane は expected skip として記録されます。Pages artifact の生成は `npm run pages:build` で行います。

## 現在の状態

この repository は schema v1、SpecQR baseline adapter、jsQR decoder lane、Nayuki fixed-condition matrix reference lane、optional zbarimg / ZXing CLI decoder lane、Kanji / ECI / binary vector suite を持つ conformance lab です。SpecQR adapter は published package を実行し、jsQR lane は生成 PNG の readability を確認し、Nayuki lane は固定 Version/ECC/mask の matrix exact match だけを確認します。optional CLI lane は command availability を検出し、missing tool を failure ではなく expected skip として記録します。
