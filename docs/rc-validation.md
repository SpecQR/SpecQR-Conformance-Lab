# RC Validation

この文書は、公開済み `specqr@3.0.0-rc.2` を SpecQR Conformance Lab から外部 black-box 検証し、stable readiness の技術的 evidence を作る専用手順を定義します。通常の public baseline は `specqr@2.4.0` のままです。RC validation は `reports/latest.json`、`reports/latest.html`、badges、GitHub Pages、npm dist-tag を変更しません。

## Fixed targets

| Role | Package spec | Expected resolved version |
| --- | --- | --- |
| Baseline | `specqr@2.4.0` | `2.4.0` |
| Exact candidate | `specqr@3.0.0-rc.2` | `3.0.0-rc.2` |
| Dist-tag candidate | `specqr@next` | `3.0.0-rc.2` |

RC 公開日時は 2026-08-02 16:38:47 JST です。Registry artifact の固定値は次です。

- tarball SHA-256: `c96c324dcd99d72c385d3890156a6ae973ad8db57b840fd5a47f987ddcbb6298`
- expanded contents SHA-256: `f507de7da842b3bc5fce88eaa6a4d04388ce1d55541c58cbebf36d4b583ae306`
- files: 121

## Commands

Node 22 の full evidence は次で生成します。

```sh
npm ci
npm run verify
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

## Raw strict common comparison

Baseline、exact candidate、dist-tag candidate は、同じ vector と adapter で full conformance report を生成します。Candidate report integrity は required gate であり、失敗を許容して comparison だけ続行する経路はありません。

Raw strict comparison は次を blocking regression とします。Expected delta policy はこの report を変更せず、3 件の raw delta と 3 件の blocking regression を残したまま別 report で判定します。

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

## RC 2 expected delta policy

RC 2 で確認された 3 件だけを adjudicate する versioned policy は [specqr-3.0.0-rc.2-expected-deltas-v1.json](../policies/specqr-3.0.0-rc.2-expected-deltas-v1.json) です。Schema は [rc-expected-delta-policy-v1.schema.json](../schemas/rc-expected-delta-policy-v1.schema.json) です。

- policy SHA-256: `77ad3e6241c8d02f698c7e4609d0e837ffce076d47255c719ecf070d69b461a0`
- policy schema SHA-256: `84955271cfc8596228cc6adecf297abece7f549f9aab699690b3f9b3d101a240`
- expected delta count: 3
- valid baseline: requested `specqr@2.4.0`、resolved `2.4.0`
- valid candidates: requested `specqr@3.0.0-rc.2` または `specqr@next`、resolved `3.0.0-rc.2`

| Vector | Operation | Before fingerprint | After fingerprint | `remainingBits` |
| --- | --- | --- | --- | --- |
| `core.estimate.data-too-long-reject` | `estimate` | `feb36244b3cba7698421c2bfe4357aa091b91980034ed6c6d2c7043cc7644c50` | `3aa336488d9fd8afbfdc1cb6ddf2ef4123f9257659d4ede5ff255af3ad9c33c9` | -381 |
| `planning.estimate.data-too-long-v1-h` | `estimate` | `13f97c0ed73c276012eaaa150d756da6ca91bac859dffea06b07a01b1816d47a` | `c8a9588eac278ac1c09249b2eaed6ca2714c4f93dd32c1d3a7130e8a3deb00e7` | -340 |
| `planning.analyze-segments.data-too-long-v1-h` | `analyzeSegments` | `b6f40826566b609cab7cd7bd674a5fbc52b591513eee415276bdc6008f4a23dd` | `e454ec71100d4de4209be8f3340b87f97423f94367483ca9a9a861c2b58bc1a2` | -340 |

全 entry の `adapterId` は `specqr` です。許可する変更 path は、次の 4 個の完全一致だけです。

1. `$.details.diagnostics.warnings.length`
2. `$.details.diagnostics.warnings[0]`
3. `$.details.planning.warnings.length`
4. `$.details.planning.warnings[0]`

各 entry は baseline と candidate の status が `passed`、planning が `ok: false`、`reason: "data-too-long"`、表の `remainingBits` と一致して 0 未満であることを required とします。Baseline の diagnostics / planning warning はそれぞれ `CAPACITY_NEAR_LIMIT` 1 件、candidate は 0 件でなければなりません。Baseline からこの 2 warning array だけを空にした normalized result が candidate と完全一致することを unchanged invariant とします。

Positive control は `planning.diagnostics.warning.capacity-near-limit` / `specqr` / `estimate` です。Baseline と candidate の両方で成功し、planning は `ok: true`、`reason: null`、`remainingBits: 1`、diagnostics / planning の両方に `CAPACITY_NEAR_LIMIT` が 1 件必要です。

Policy は exact RC と `next` へ独立に適用します。両方が raw 3、matched 3、missing 0、unexpected 0 で、entry evidence と control が一致した場合だけ adjudication は pass です。Extra / missing delta、adapter / vector / operation / path / full fingerprint / warning code の不一致、precondition failure、unchanged field drift、control 消失、version 変更、`next` mismatch、policy または schema の hash 変更は failure です。

Wildcard、path prefix、vector group、warning code だけの broad allowlist は認めません。Baseline、candidate requested / resolved version、RC number、raw delta count、fingerprint、path、precondition、unchanged invariant、control のどれかが変われば policy は失効します。Stable、RC 3、別 baseline へ自動適用しません。

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
- raw strict delta と exact / `next` の expected-delta matched / missing / unexpected
- expected-delta policy / schema path、SHA-256、entry evidence、positive control
- v3 candidate contract の required check count
- optional skip と non-claims
- evidence file ごとの SHA-256 と artifact set SHA-256
- `technicalStatus` と `observationStatus`

Intermediate conformance report、raw strict comparison、expected-delta JSON / Markdown、policy / schema snapshot、v3 contract JSON、registry manifest、logs も同じ Actions artifact に含めます。これらは generated evidence であり、通常は repository へ commit しません。

`npm run rc:validate` は report field の semantic consistency に加え、policy/schema hash、raw comparison、full result fingerprint、exact / `next` adjudication、evidence file の存在、regular file、size、SHA-256、安全な relative path、重複、および artifact set SHA-256 を再計算します。

## Stable boundary

`technicalStatus: "pass"` は、registry integrity、91 vectors / 455 results、raw strict 3 件、expected delta 3 / 3 matched・0 missing・0 unexpected、v3 contract 35 / 35、Node 18 / 20 / 22 / 24 matrix がすべて green であることだけを示します。

`observationStatus` は利用観察の独立 status です。この検証だけでは `"sufficient"` にしません。RC readiness workflow は常に `"pending"` を出し、stable 公開判断には別途、公開後の利用期間、consumer feedback、issue / regression observation、必要な compatibility confirmation を要求します。

この evidence は次を claim しません。

- stable tag または npm `latest` へ進める最終承認
- 利用観察が十分であること
- GitHub Release、GitHub Pages、badges の更新
- full QR reader、Micro QR、rMQR、full GS1 catalog
- browser DOM integration または scanner metadata interoperability
