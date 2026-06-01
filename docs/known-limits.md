# Known Limits

この repository は SpecQR を外部から検証する conformance lab であり、SpecQR core そのものではありません。npm に公開された package を対象に、外部から観測できる結果を記録します。現時点の制限は次の通りです。

- SpecQR adapter は `generate`, `generateSegments`, `estimate`, `analyzeSegments`, `getCapacity` の baseline 実行に対応している。
- Planning / Diagnostics vector は `specqr@2.4.0` の `estimate`, `analyzeSegments`, `getCapacity` の subset と warning code surface を確認する。warning message の全文一致はしない。
- SpecQR adapter は published `specqr@2.4.0` の GS1 helper / Digital Link helper を実行する。ただし対象は SpecQR がサポートする AI subset であり、GS1 full catalog の conformance ではない。
- SpecQR adapter は published `specqr@2.4.0` の Structured Append generation / manual segment splitting / merge helper を実行する。
- jsQR adapter は `generate` / `generateSegments` vector の decode readability に対応している。
- Nayuki adapter は固定 Version/ECC/mask の `referenceMatrix` exact match にだけ対応している。
- Nayuki lane は GS1、Kanji、Structured Append、renderer output、auto segmentation の同等性を主張しない。
- jsQR は FNC1、Structured Append、ECI などの QR metadata をすべて露出するわけではない。Structured Append の header、sequence、parity、merge metadata validation は jsQR lane の対象外。
- binary raw-byte validation は jsQR result の `binaryData` に依存する。raw bytes が得られない場合は `decode.binaryHex` check を制限として `skipped` にする。
- validator は schema v1 の形、operation enum、`binaryHex`、negative expectation を検査するが、QR の数学的妥当性までは検査しない。
- 対象は QR Code Model 2。
- 何を検証していないか: Micro QR。
- 何を検証していないか: rMQR。
- 何を検証していないか: full GS1 catalog。現時点の GS1 vector は AI `00`, `01`, `10`, `17` と Digital Link の代表的な validation/normalization case を中心にする。
- 何を検証していないか: full QR reader。
- 何を検証していないか: scanner metadata merge support。Structured Append の scanner metadata decoding や decoder merge support は実装しない。metadata-returning decoder がある前提で `mergeStructuredAppendParts()` helper の入力検証だけを確認する。
- 何を検証していないか: logo/styled QR。
- SpecQR target は npm package `specqr@2.4.0`。SpecQR core repository の source tree や local checkout は検証入力として使わない。
