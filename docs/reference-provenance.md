# Fixed-segmentation reference evidence

`vectors/reference-nayuki.json` は、SpecQR の公開生成 API を、独立して公開されている `nayuki-qr-code-generator@1.8.0` と比較します。比較のたびに、両方の行列を実行時に生成します。期待行列には、SpecQR が生成したもの、SpecQR のテストからコピーしたもの、SpecQR の出力から更新できるスナップショットとして保存したものを使用しません。

## Oracle provenance

[npm ラッパーのリポジトリ](https://github.com/maltsev/nayuki-QR-Code-generator) は、[Project Nayuki's QR Code generator](https://github.com/nayuki/QR-Code-generator) をパッケージ化したものです。インストールされるソースには Project Nayuki の MIT 著作権表示があり、[上流ライブラリーの説明](https://www.nayuki.io/page/qr-code-generator-library) を参照しています。このラッパーは第三者による配布物です。本 Lab は、これを規格の公式な判定基準や認証サービスとして説明していません。

依存パッケージとその tarball の完全性を確認する値は、`package.json` と `package-lock.json` で固定しています。

| 項目 | 固定値 |
| --- | --- |
| パッケージ | `nayuki-qr-code-generator@1.8.0` |
| tarball | `https://registry.npmjs.org/nayuki-qr-code-generator/-/nayuki-qr-code-generator-1.8.0.tgz` |
| tarball の完全性値 | `sha512-wnpXdJ+zJ+8QzzGJTEnESaRYfNIUHSgX4ykvYuaomqqUbhJdun3v0sK/39BQjw3on/vf7ujPKIg2V07WejjmLw==` |
| インストールされる `index.js` の SHA-256 | `daa3aa30adbaf99c4e415f33b9042767e74f053896e55ad06f898d344917d2a7` |

`node tools/test-reference-coverage.js` は、参照実装をインポートする前に、インストール済みのバージョン、パッケージの厳密なバージョン固定、ロックファイルの完全性値、ソースのハッシュを確認します。依存パッケージを意図的に更新する場合は、この出典情報を確認し、これらの期待値もまとめて更新する必要があります。レポート内の行列ハッシュは、生成された行列を表すものであり、依存パッケージのソースを表すものではありません。

## Committed scope

収録した 46 件のベクターは、従来の数字、英数字、UTF-8 バイト、手動指定の混在セグメント、ECI 26、バイナリーのケースを維持し、次のケースを追加しています。

- 全 32 組の ECC/マスクの組合せ（`L/M/Q/H` × マスク `0..7`）。バージョン 1 で同じ数字ペイロードを使用します。
- 数字・英数字・バイトの混在セグメント。バージョン情報が始まる境界をまたぐバージョン 6 と 7、および文字数フィールドのビット幅が変わる境界をまたぐバージョン 9/10 と 26/27 を対象とします。バイト数フィールドのビット幅は 9/10 で変わりますが、26/27 では 16 ビットのままです。数字と英数字のビット幅は、両方の境界で変わります。
- 決定的なバイナリーパターンを用いた、単一のバイトセグメントの容量上限。バージョン 1-H（7 バイト）、バージョン 40-L（2,953 バイト）、バージョン 40-H（1,273 バイト）を対象とします。個別テストでは、いずれの実装も上限を 1 バイト超えた入力を拒否することを要求します。これらの容量は、ECI ヘッダーなし、バージョン・ECC・マスクの明示指定、ECC ブースト無効の条件でテストします。

`QrCode.encodeSegments` には、明示的に構築した数字、英数字、またはバイトのセグメントを渡します。バージョンの最小値と最大値を同じにし、マスクを固定し、ECC ブーストを無効にします。これにより、最適化処理とマスク選択の違いを比較から取り除きます。各正常ケースの結果は `referenceMatrix.exact` に合格する必要があり、SpecQR と Nayuki の行列ハッシュは、どちらも独立した参照実装で新たに計算した結果と一致しなければなりません。

個別テストでは、行列の 1 モジュールを変更するケースと、ペイロードの数字を 1 桁変更するケースも確認します。いずれの異常対照でも行列の不一致が生じる必要があり、1 モジュールを変更するケースでは、その正確な座標を特定する必要があります。一時的な公開 API ラッパーは、`generate` と `generateSegments` の両方の出力に対して 1 モジュールを破損させます。実際のアダプターは、選択されたターゲットの各結果に対して `failed` を返し、その座標と、ターゲット・参照実装間で異なるハッシュを示す必要があります。この対照は、意図しない自己比較や、選択されたターゲットを経由しない処理を検出します。ラッパーはテスト後に削除し、その結果を適合性の証拠として使用することはありません。この参照レーンでは、未対応の自動セグメント分割、漢字、GS1/FNC1、対応済みの UTF-8 割当て以外の ECI 割当て、Structured Append を、引き続き明示的にスキップします。

## Reproduce

```sh
npm ci
node tools/test-reference-coverage.js
node tools/run-conformance.js --suite reference-nayuki --adapter nayuki --output reports/reference.local.json
```

2 番目のコマンドは、独立した参照ソースの出典、網羅した件数、異常対照の証拠を示します。3 番目のコマンドは、ベクターごとにその場で比較を実行し、ハッシュを生成します。レポートでは、インストール済みの SpecQR ターゲットを別途識別します。RC ターゲットには新たな実行が必要であり、安定版ターゲットの結果を引き継ぐことはできません。

これは、QR Code Model 2 の生成に関する、範囲を限定した差分比較の証拠です。バージョンやペイロードの完全な網羅、最適なセグメント分割、自動選択されるマスクの品質、漢字・GS1・Structured Append の参照実装との同等性、スキャンやレンダラーの正しさ、ISO/IEC の公式認証を主張するものではありません。有料規格の本文は含めておらず、直接検証した出典としても扱っていません。
