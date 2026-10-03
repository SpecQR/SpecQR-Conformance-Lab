# RC Observation

この文書は、公開済み `specqr@3.0.0-rc.2` の利用観察 evidence を時系列で取得し、stable go / no-go 判断へ渡す入力条件を定義します。この pipeline は stable 公開を実行せず、npm dist-tag、GitHub Release、GitHub Pages、default `specqr@2.4.0` report を変更しません。

## Fixed target

| Field | Value |
| --- | --- |
| Exact candidate | `specqr@3.0.0-rc.2` |
| Dist-tag candidate | `specqr@next` |
| Resolved version | `3.0.0-rc.2` |
| Published at | `2026-08-02T07:38:47.138Z` |
| Tarball SHA-256 | `c96c324dcd99d72c385d3890156a6ae973ad8db57b840fd5a47f987ddcbb6298` |
| Expanded SHA-256 | `f507de7da842b3bc5fce88eaa6a4d04388ce1d55541c58cbebf36d4b583ae306` |
| Historical technical run (revoked) | `30739905031` |

Observation policy は [specqr-3.0.0-rc.2-observation-v1.json](../policies/specqr-3.0.0-rc.2-observation-v1.json) です。Policy schema は [rc-observation-policy-v1.schema.json](../schemas/rc-observation-policy-v1.schema.json)、report schema は [rc-observation-v1.schema.json](../schemas/rc-observation-v1.schema.json) です。Manual review、consumer confirmation、reported blocker は [specqr-3.0.0-rc.2-observation-manual-v1.json](../evidence/specqr-3.0.0-rc.2-observation-manual-v1.json) に記録し、[rc-observation-manual-evidence-v1.schema.json](../schemas/rc-observation-manual-evidence-v1.schema.json) で検証します。

## Historical evidence revocation

2026-10-03 の audit で、独立 adapter の subject generation が isolated RC ではなく pinned `specqr@2.4.0` を参照する defect を確認しました。Historical run [30739905031](https://github.com/SpecQR/SpecQR-Conformance-Lab/actions/runs/30739905031) と head `383399338481ed80acf9f596099bbeb9c79a59cb` は technical evidence として失効しています。元の policy / artifact hash は履歴を識別するために保存し、green の根拠には使いません。

新しい technical evidence には各 target の shared subject routing revision、実際の subject package version / content SHA-256、および現在の source vectors / adapter scope の SHA-256 が必要です。Readiness assembler / validator は全 raw conformance report の schema と current target-normalized suite を検証し、source-backed coverage claims の required capability / check を確認します。Candidate subject digest は固定 expanded SHA-256 を満たす raw registry manifest に照合します。Observer もこの binding と `capabilityCoverage` を確認し、composite `conformanceEvidenceRevision` を current / historical snapshot に要求します。Routing evidence がない旧 report と、失効した run を参照する過去 snapshot は、保存済み status が `pass` でも observation timeline を満たしません。

この修正は、観察済み期間や独立 consumer の確認を作りません。公開後 72 時間未満の initial snapshot は現在の実行で再作成できず、過去の timestamp に現在の evidence を当てはめることも認めません。現行 policy の publication date、168 時間、3 snapshot、48 時間 gap、consumer confirmation 条件は維持します。信頼できる initial evidence がなければ `sufficient` は到達できません。必要な policy 改訂や新しい observation window は maintainer が別途明示的に判断する事項です。

Checked-in manual evidence の `consumerConfirmations` は空です。Fresh technical run と実際の独立 consumer evidence は未完了であり、software の検証完了だけでは stable readiness になりません。

## Observation policy

`observationStatus: "sufficient"` には次のすべてが必要です。

- RC 2 公開後 168 時間以上を経過している。
- 少なくとも 3 snapshot がある。
- Initial snapshot、公開後 72 時間以降の snapshot、公開後 168 時間以降の snapshot がある。
- 選択した最終 2 snapshot の間隔が 48 時間以上である。
- Final snapshot で exact candidate と `specqr@next` の RC readiness を再実行し、technical gate が green である。
- Exact candidate と `specqr@next` がともに `3.0.0-rc.2` へ解決し、dist-tag、tarball、expanded content、manifest、exports、runtime smoke が固定 evidence と一致する。
- SpecQR core と SpecQR Conformance Lab に、未解決の blocking defect、regression、security issue、migration failure がない。
- Public npm registry package だけを使う独立 consumer confirmation が 1 件以上ある。

最短 milestone は次です。

| Milestone | UTC | JST |
| --- | --- | --- |
| 72 hours | `2026-08-05T07:38:47.138Z` | 2026-08-05 16:38:47.138 JST |
| 168 hours | `2026-08-09T07:38:47.138Z` | 2026-08-09 16:38:47.138 JST |

`unreviewed` item、期間不足、snapshot 不足、confirmation 不足、final rerun 不足は `pending` です。Registry drift、candidate / dist-tag / hash mismatch、technical failure、manual に確認された open blocker は `blocked` です。全 criteria が明示的に `pass` の場合だけ `sufficient` です。

## Commands

Fresh snapshot は修正済み commit の technical readiness が green になってから、次の順で生成、組立、検証します。

```sh
npm run observation:snapshot -- \
  --expected-commit <lab-commit> \
  --technical-run-id <fresh-readiness-run-id>
npm run observation:assemble
npm run observation:validate
```

選択済みの previous observation artifact を時系列へ追加する場合は次を使います。

```sh
npm run observation:assemble -- \
  --previous-report <downloaded-artifact>/observation.json
```

`.github/workflows/rc-observation.yml` は `workflow_dispatch` と 1 日 1 回の schedule を持ちます。Schedule run は独立 snapshot を artifact 化します。72 時間と 168 時間の required timeline を組むときは、`previous_observation_run_id` に採用する直前の observation run を明示します。自動的に全 daily run を採用しないため、最終 2 snapshot の 48 時間条件を曖昧にしません。

`technical_run_id` に historical run の default はありません。Manual dispatch では、新たに green になった `.github/workflows/rc-readiness.yml` の run ID を明示します。Scheduled run は repository variable `SPECQR_RC_TECHNICAL_RUN_ID` を使用し、未設定なら失敗します。この variable は修正済み commit の fresh run が確認された後に設定します。Final rerun は observation workflow と同じ Lab commit を検証する必要があります。

Live collector の `--observed-at` は取得時刻の直近 5 分以内だけを許可します。Historical snapshot の再検証には、その当時に取得した original artifact が必要です。

## Evidence sources

Snapshot command は npm の effective registry が `https://registry.npmjs.org/` であることを確認し、public npm registry から exact candidate と `specqr@next` を別々の temporary install へ取得します。Tarball URL、tarball SHA-256、expanded SHA-256、file manifest、metadata、runtime dependency 0、root / Node / browser exports、representative runtime smoke を検査します。Local tarball、registry mirror、SpecQR core checkout、direct source import への fallback はありません。

GitHub snapshot は GitHub REST API から次を取得します。

- `SpecQR/SpecQR` の open issue / pull request
- `SpecQR/SpecQR-Conformance-Lab` の open issue / pull request
- 指定した RC readiness run と Actions artifact metadata
- Download した readiness artifact の archive SHA-256 と `readiness.json` SHA-256

Issue / PR record は repository、number、state、labels、created / updated / closed timestamp、URL、classification、reason を持ちます。新しい open item は label や title だけで blocker にせず、manual evidence が追加されるまで `unreviewed` です。Manual review だけが `non-blocking` または `blocking` を確定します。Item の `updatedAt` が `reviewedAt` より新しくなった場合は、再 review まで `unreviewed` に戻します。

Token と credential は report、Markdown、collector log に保存しません。Generated snapshot、report、manifest、logs は `reports/observation/` に作り、Actions artifact だけへ upload します。Repository へ自動 commit しません。

## Independent consumer evidence

独立 consumer confirmation は automated Lab fixture と別の実 project または独立 sample でなければなりません。Manual evidence entry には次をすべて記録します。

- Public project または独立 sample の URL
- Exact 40-character commit SHA
- Public npm registry の `specqr@3.0.0-rc.2` を使ったこと
- `independent: true`、`automatedFixture: false` と独立性の理由
- 実行 log URL
- Log の SHA-256
- Verification timestamp と結果 summary

Lab 内の TypeScript fixture や自動 conformance vector だけでは independent confirmation になりません。Feedback が 0 件であることも肯定的 feedback と数えません。

## Integrity and rejection

Validator は policy / schema の固定 SHA-256、manual evidence hash、raw registry / GitHub / technical evidence、snapshot fingerprint、listed file size / SHA-256、artifact set SHA-256 を再計算します。Current snapshot と report も raw evidence から再構成します。

次は validation failure です。

- Future `observedAt` または生成時刻
- Duplicate snapshot、clock rollback、non-increasing timestamp
- Candidate、`specqr@next`、dist-tag、artifact hash、registry fingerprint の drift
- Technical readiness failure、revoked run / head、subject routing / source scope、required Node / v3 contract evidence の欠落
- Snapshot、manual evidence、policy、schema、manifest、listed evidence file の改変

Pending criteria は正常な未成熟状態なので validator 自体は成功します。`blocked` report は validator failure です。Workflow は gate を緩和せず、失敗時も生成済み failure log と evidence を artifact として upload します。

## Stable boundary

`technicalStatus: "pass"` は package と RC conformance の technical evidence が green であることだけを表します。`observationStatus: "sufficient"` は上記の観察条件が揃ったことを表しますが、それ自体は stable publish approval ではありません。

将来の stable go / no-go goal は、少なくとも次を入力として別途実行します。

- 3 件以上の selected observation snapshot とその Actions artifact URL
- 168 時間以降の final snapshot と 48 時間以上前の直前 selected snapshot
- Final exact / `next` technical readiness run と artifact
- 全 open issue / PR の manual classification
- 独立 consumer confirmation の URL、commit、log、hash
- Open blocker 0 件と全 observation criteria の明示的 pass

その goal でも stable publish、npm dist-tag、GitHub Release、Pages 更新は自動実行せず、maintainer の明示的な判断を要求します。
