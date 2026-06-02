# Adapters

adapter は vector schema v1 を各 QR 実装の API に接続するための層です。Conformance Lab は adapter に vector を渡し、adapter は `passed`, `failed`, `skipped`, `error` のいずれかを返します。

adapter は次の lane を持ちます。

- `specqr.js`: 公開 npm package `specqr@2.4.0` を対象にする active adapter。生成、Planning / Diagnostics API、GS1 / Digital Link helper subset、Structured Append helper を実行します。
- `jsqr.js`: SpecQR-generated PNG を jsQR で decode する active decoder lane。
- `nayuki.js`: fixed Version/ECC/mask の matrix exact match だけを確認する active reference lane。
- `zbar.js`: local `zbarimg` command がある場合だけ実行する optional decoder lane。
- `zxing-cli.js`: local ZXing CLI command (`ZXingReader`, `zxing`, `zxing-cpp`, `zxingscan`) がある場合だけ実行する optional decoder lane。

jsQR lane は Planning API、Structured Append metadata validation、decoder merge support を主張しません。Nayuki lane も Planning API と Structured Append は scope 外として skip します。optional CLI decoder lane は command がない環境では expected skip を返し、CI failure にはしません。

adapter は npm package や各 dependency の公開 API を通して検証します。SpecQR core repository の source tree や contributor の local checkout から source file を読み込む設計ではありません。
