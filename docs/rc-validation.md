# RC Validation

この文書は、公開済み `specqr@3.0.0-rc.1` を SpecQR Conformance Lab から外部 black-box 検証し、stable readiness の技術的 evidence を作る専用手順を定義します。通常の public baseline は `specqr@2.4.0` のままです。RC validation は `reports/latest.json`、`reports/latest.html`、badges、GitHub Pages、npm dist-tag を変更しません。

## Fixed targets

| Role | Package spec | Expected resolved version |
| --- | --- | --- |
| Baseline | `specqr@2.4.0` | `2.4.0` |
| Exact candidate | `specqr@3.0.0-rc.1` | `3.0.0-rc.1` |
| Dist-tag candidate | `specqr@next` | `3.0.0-rc.1` |

RC 公開日時は 2026-08-02 13:27:44 JST です。Registry artifact の expected SHA-256 は次です。

- tarball: `ad1c384475ff09cc27fcbb5479d2a230431dab43d403b86deba13b1005530f04`
- expanded contents: `b8f906d95076316c7de97a3a4f376dfbea70e4aef2e19dbeb6dbbfde96b577d4`

## Commands

Node 22 の full evidence は次で生成します。

```sh
npm ci
npm run rc:full -- --require-node 22
```

Node 18 / 20 / 22 / 24 の package surface evidence は、各 runtime で次を実行します。

```sh
npm run rc:package-surface -- --node-major 22
```

GitHub Actions では `.github/workflows/rc-readiness.yml` が 4 runtime の artifact と Node 22 の full artifact を集約します。集約と schema / semantic validation の command は次です。

```sh
npm run rc:assemble -- --expected-commit <commit>
npm run rc:validate -- --report reports/rc/readiness.json
```

workflow dispatch の `expected_commit` は required です。各 job はその commit を checkout し、`git rev-parse HEAD` が一致しない場合に失敗します。

## Registry integrity

Exact candidate と dist-tag candidate は、互いに異なる temporary directory へ npm registry から install します。検証は次を required とします。

- requested spec ごとの `npm view` metadata と resolved version
- registry tarball URL から直接取得した bytes の SHA-256、SHA-512 integrity、SHA-1 shasum
- tar archive の regular files から作る canonical expanded manifest
- install 後 package directory と tar archive の path、size、content SHA-256 の一致
- package metadata、root / `specqr/node` / `specqr/browser` exports
- representative root matrix と Node PNG runtime smoke
- runtime dependency count が 0
- exact candidate と dist-tag candidate の package contents、metadata、exports、runtime result の一致

Expanded SHA-256 は、tar archive の `package/` 以下にある file を path の bytewise order で並べ、各 file を `{ path, size, sha256 }` とした JSON 1 行と末尾 newline の SHA-256 です。Symlink、unsafe path、duplicate path、tar checksum mismatch は failure です。

Local tarball、SpecQR core checkout、direct source import への fallback はありません。Registry access または temporary install に失敗した場合は、そのまま blocked です。

## Strict common comparison

Baseline、exact candidate、dist-tag candidate は、同じ vector と adapter で full conformance report を生成します。Candidate report integrity は required gate であり、失敗を許容して comparison だけ続行する経路はありません。

次を blocking regression とします。

- common vector / adapter の新しい `failed` または `error`
- baseline にある result または required check の欠落
- required adapter の `skipped` 増加
- suite / adapter contract の変更
- normalized result の matrix、renderer、helper、diagnostics、package surface result の変更
- exact candidate と dist-tag candidate の normalized report 不一致

Optional adapter の availability skip は adapter 別に report します。Optional availability 自体は required coverage claim に昇格しませんが、実行された result の mismatch は隠しません。

### Normalization rules

次だけを common behavior comparison から除外します。

1. `generatedAt`、runtime provenance、report output path
2. requested / resolved target、`metadata.packages.specqr`、SpecQR adapter package version
3. Package Surface metadata vector の package version
4. Manual Structured Append diagnostics の `splitUnits`、`splitUnitsDetail`、`splitUnitCount`

4 番目は breaking change を無視するためではありません。Common regression から分離し、次の v3 candidate contract で required evidence として検証します。Matrix、renderer output、symbol result、offset 以外の summary、warning、helper result は正規化しません。

## v3 candidate contract

`tools/verify-v3-contract.js` は公開 root API と公開 TypeScript declarations だけを使います。Core source、private fixture、local checkout の期待値は使いません。Input は Lab 独自の numeric、alphanumeric、UTF-8 byte segments で、logical split unit と byte offset を `TextEncoder` から独立に構成します。

Required contract は次です。

- standard diagnostics が `splitUnitsDetail: "summary"` と正確な `splitUnitCount` を持つ
- standard diagnostics が own `splitUnits` property を持たず、JSON にも出さない
- `{ splitUnits: "full" }` が plain eager array を返す
- full array の source order、logical offset、byte offset、property order が独立期待値と一致する
- full array と entry が mutable で、fresh call と state を共有しない
- JSON round-trip と `structuredClone()` が plain data contract を保つ
- `symbolResults: "output"` が requested output を返す
- `symbolResults: "diagnostics"` が per-symbol diagnostics result を返す
- detail selection と symbol selection が matrix result を変えない
- named export と `QRCode` static method が同じ結果を返す
- literal / dynamic TypeScript consumer が candidate package declarations に対して compile する
- raw `generateStructuredAppend()` の named / static API が manual 専用 diagnostics object を `INVALID_INPUT` で拒否する

この suite は candidate 専用です。`specqr@2.4.0` に実行して baseline failure を作りません。Exact candidate と dist-tag candidate は required check count、各 outcome、public result fingerprint まで一致する必要があります。

## Readiness report

Final Actions artifact は `reports/rc/readiness.json` と `reports/rc/readiness.md` を含みます。JSON は [RC readiness schema](../schemas/rc-readiness-v1.schema.json) に従い、少なくとも次を記録します。

- exact commit と RC publication metadata
- baseline、exact candidate、dist-tag candidate
- Node 22 full suite と Node 18 / 20 / 22 / 24 package surface matrix
- registry integrity、file count、artifact hashes、runtime dependency count
- target 別 conformance summary と adapter 別 pass / skip / fail / error
- common regression と normalization rules
- v3 candidate contract の required check count
- optional skip と non-claims
- evidence file ごとの SHA-256 と artifact set SHA-256
- `technicalStatus` と `observationStatus`

Intermediate conformance report、strict comparison、v3 contract JSON、registry manifest、logs も同じ Actions artifact に含めます。これらは generated evidence であり、通常は repository へ commit しません。

## Stable boundary

`technicalStatus: "pass"` は、この workflow が定義する registry integrity、common regression、v3 contract、Node matrix が green であることだけを示します。

`observationStatus` は利用観察の独立 status です。この検証だけでは `"sufficient"` にしません。RC readiness workflow は常に `"pending"` を出し、stable 公開判断には別途、公開後の利用期間、consumer feedback、issue / regression observation、必要な compatibility confirmation を要求します。

この evidence は次を claim しません。

- stable tag または npm `latest` へ進める最終承認
- 利用観察が十分であること
- GitHub Release、GitHub Pages、badges の更新
- full QR reader、Micro QR、rMQR、full GS1 catalog
- browser DOM integration または scanner metadata interoperability
