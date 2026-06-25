# Security Policy

SpecQR Conformance Lab は conformance / report / comparison infrastructure です。QR generation core ではありません。SpecQR core の生成ロジックや package 実装の脆弱性は、core repository 側で扱います。この repository では、外部検証、workflow、artifact、report publishing、schema、adapter 実行に関わる security issue を扱います。

## Reporting a security issue

token、credential、private path、未公開 exploit detail を public issue に書かないでください。GitHub の private vulnerability reporting / Security Advisory が利用できる場合はそれを使います。利用できない場合は、public issue には最小限の概要だけを書き、maintainer と private な共有方法を決めてから詳細を送ってください。

報告に含めると有用な情報:

- 影響する workflow、adapter、report、schema、または Pages path。
- 再現手順。機密 token や private URL は伏せる。
- 期待される影響。例: artifact 改ざん、secret exposure、report publishing path の混線。
- 関連する commit SHA や workflow run URL。

## Security-sensitive changes

次の変更は security-sensitive として扱います。

- GitHub Actions workflow、permission、OIDC、Pages deploy、artifact upload の変更。
- auth token、secret、credential、npm publishing、GitHub release に関わる変更。
- runtime / dev dependency の追加や major update。
- report、badge、schema、comparison output の public publishing path 変更。
- adapter が外部 command、network、filesystem に触れる範囲の変更。

## Data hygiene

report、docs、summary、artifact、schema example に private token、secret、local machine path、private account name を含めないでください。公開 report は portable である必要があります。test suite は public-facing files に local path や実装環境名が混ざらないことを検査します。

## Supported versions

現時点では、この repository は public Pages と main branch の conformance artifacts を最新の運用対象とします。release package としての version support はまだ開始していません。release を開始する場合は [docs/release-readiness.md](docs/release-readiness.md) を更新します。
