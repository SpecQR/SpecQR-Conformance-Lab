# Maintenance

この文書は maintainer 向けの運用メモです。release 手順ではなく、通常の repository hygiene を保つための確認事項です。

## Routine checks

- main branch の Verify / Pages workflow が green であることを確認する。
- public report と schema URL が到達可能であることを確認する。
- `reports/latest.json` の target が pinned baseline を指していることを確認する。
- optional decoder skip が expected skip として説明されていることを確認する。
- issue templates から来た request が vector、adapter、report problem のどれかに分類できることを確認する。
- RC readiness を実行した場合は exact commit、Node 18 / 20 / 22 / 24 matrix、Node 22 full gate、raw strict delta、expected-delta matched / missing / unexpected、policy/schema hash、artifact retention を確認し、default public report が `specqr@2.4.0` のままであることを再確認する。
- Expected-delta policy は baseline と resolved candidate version に厳密に pin し、stable、次の RC、別 baseline、fingerprint/path/precondition/control の変化があれば失効させる。Wildcard、path prefix、vector group、warning code だけの allowlist へ広げない。
- RC observation を実行した場合は policy / schema hash、exact candidate / `next` registry integrity、technical evidence run、open issue / PR の manual classification、snapshot chronology、consumer confirmation、blocker、artifact retention を確認する。Feedback 0 件を肯定的 feedback と数えず、`observationStatus: "sufficient"` だけで stable publish を実行しない。
- Daily observation artifact は自動で全件を timeline に採用しない。72 時間以降と 168 時間以降の selected snapshot、最終 2 snapshot の 48 時間以上の間隔、final technical rerun を明示的に確認する。

## Before changing workflows

workflow permission、artifact upload、Pages deploy、manual dispatch input を変更する場合は [SECURITY.md](../SECURITY.md) と [docs/dependency-policy.md](dependency-policy.md) を確認します。token や private path を summary、report、artifact に出さないことを必ず確認します。

## Before adding adapters

adapter は public package surface または optional command だけを使います。SpecQR core source import は禁止です。missing optional command は expected skip、実行済み expectation mismatch は failure として扱います。
