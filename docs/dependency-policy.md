# Dependency Policy

SpecQR Conformance Lab は reproducible report を優先します。dependency update は、public baseline、comparison workflow、report schema、Pages artifact への影響を確認してから行います。

## SpecQR target

`specqr` は public baseline のために exact pin します。通常の `npm run conformance`、Verify workflow、Pages workflow は pinned dependency の `specqr@2.4.0` を使い、`reports/latest.json` に `target.requested` と `target.resolvedVersion` を記録します。

`specqr@latest` や `specqr@next` は manual target workflow で調査します。automatic dependency bump で public baseline を変えません。candidate run は `reports/candidate.json` と comparison artifact として扱い、release claim にはしません。

Published `specqr@3.0.0-rc.2` の dedicated readiness workflow も default pin を変更しません。Exact RC と `specqr@next` は別々の temporary install へ registry から取得し、content hash と package surface を照合します。RC 2 expected-delta policy は resolved version に厳密に pin し、stable、別 RC、別 baseline には適用しません。Local tarball や core checkout へ fallback せず、generated evidence は `reports/rc/` の Actions artifact として扱います。詳細は [RC Validation](rc-validation.md) を参照してください。

RC observation workflow も exact RC と `specqr@next` を public npm registry から temporary install し、default dependency を変更しません。Snapshot、manual review、consumer confirmation、logs、manifest は `reports/observation/` の Actions artifact として扱い、自動 commit や Pages deploy を行いません。詳細は [RC Observation](rc-observation.md) を参照してください。

## Optional native / CLI decoders

`zbarimg` と ZXing CLI は optional decoder lane です。native command がない環境では expected `skipped` として記録します。これらは npm dependency にしません。CI の success は native decoder が存在することを前提にしません。

## Adding dependencies

新しい dependency を追加する場合は、PR / commit message / docs のいずれかで理由を説明します。

- 何の adapter、schema validation、report generation、または workflow に必要か。
- runtime dependency か devDependency か。
- public report の再現性にどう影響するか。
- security-sensitive surface が増えるか。
- exact pin できるか。

原則として exact pin を使います。特に report 生成や adapter 実行に関わる package は、version drift によって public report が変わらないよう固定します。

## GitHub Actions and automation

GitHub Actions は Dependabot で update 候補を作ってよい対象です。ただし baseline dependency、特に `specqr` は Dependabot で自動更新しません。Actions update でも workflow permission、artifact upload、Pages deploy path が変わる場合は security-sensitive change として review します。

## Lockfile

`package-lock.json` は reproducibility の一部です。dependency を変更した場合は `npm install` で lockfile を更新し、`npm ci` で再現できることを確認します。manual target workflow は `npm install --no-save --package-lock=false` を使い、`package.json` と `package-lock.json` を変更しないことを確認します。
