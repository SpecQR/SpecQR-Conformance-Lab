# Maintenance

この文書は maintainer 向けの運用メモです。release 手順ではなく、通常の repository hygiene を保つための確認事項です。

## Routine checks

- main branch の Verify / Pages workflow が green であることを確認する。
- public report と schema URL が到達可能であることを確認する。
- `reports/latest.json` の target が pinned baseline を指していることを確認する。
- optional decoder skip が expected skip として説明されていることを確認する。
- issue templates から来た request が vector、adapter、report problem のどれかに分類できることを確認する。

## Before changing workflows

workflow permission、artifact upload、Pages deploy、manual dispatch input を変更する場合は [SECURITY.md](../SECURITY.md) と [docs/dependency-policy.md](dependency-policy.md) を確認します。token や private path を summary、report、artifact に出さないことを必ず確認します。

## Before adding adapters

adapter は public package surface または optional command だけを使います。SpecQR core source import は禁止です。missing optional command は expected skip、実行済み expectation mismatch は failure として扱います。
