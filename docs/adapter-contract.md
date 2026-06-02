# Adapter Contract

adapter は vector schema v1 と各 QR 実装の API の間に置く薄い境界です。Conformance Lab は adapter に vector を渡し、adapter は実装固有の処理を行って machine-readable result を返します。

## 入力

adapter は `docs/vector-schema.md` の vector object を受け取ります。最低限、次の field を前提にできます。

- `id`
- `title`
- `category`
- `operation`
- `input`
- `options`
- `expect`
- `tags`
- `notes`

`operation` が未対応の場合、adapter は例外にせず `skipped` を返します。

## Export Shape

各 adapter は ESM module として次の形を export します。

```js
export const adapter = {
  id: "specqr",
  name: "SpecQR",
  packageName: "specqr",
  packageVersion: "2.4.0",
  status: "active",
  async run(vector) {
    return {
      vectorId: vector.id,
      adapterId: "specqr",
      status: "skipped",
      reason: "Placeholder adapter"
    };
  }
};

export default adapter;
```

## Result Shape

adapter result は次の field を持ちます。

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `vectorId` | string | yes | 実行した vector ID。 |
| `adapterId` | string | yes | adapter ID。 |
| `status` | string | yes | `passed`, `failed`, `skipped`, `error` のいずれか。 |
| `checks` | array | yes | expectation ごとの check result。例: `diagnostics.subset`, `decode.text`, `decode.binaryHex`。 |
| `reason` | string | no | `skipped` や `error` の説明。 |
| `details` | object | no | 比較に使った値や実装固有 diagnostics。 |

`details` は report 用の補助情報です。判定の正本は `status` と `expect` に基づく比較結果です。

## Decoder Adapter

decoder adapter は、生成済みまたは adapter 内で生成した画像を読み、`expect.decode` を評価します。現在の jsQR lane は SpecQR の published package で PNG を生成し、その PNG を jsQR に渡します。

decoder adapter の result は通常の adapter result と同じ形ですが、`checks` は decode 専用の名前を使います。

```json
{
  "vectorId": "core.generate.byte-text",
  "adapterId": "jsqr",
  "status": "passed",
  "checks": [
    {
      "name": "decode.text",
      "status": "passed"
    }
  ],
  "details": {
    "decoded": {
      "text": "HELLO SPECQR",
      "binaryHex": "48454c4c4f20535045435152"
    }
  }
}
```

`expect.decode.text` は decoded text の完全一致で判定します。`expect.decode.binaryHex` は decoder が raw byte を安定して返せる場合に比較します。decoder が raw byte を公開できない場合は、vector 全体を失敗させず `decode.binaryHex` check を `skipped` にし、理由を `reason` に書きます。

decoder adapter は decode expectation がない vector、または対象外 operation を `skipped` にできます。たとえば jsQR lane は `generate` / `generateSegments` だけを対象にし、`estimate` などの Planning API vector は clear reason 付きで skip します。

jsQR lane の decode readability は Structured Append metadata validation ではありません。`structuredAppend.*` operation は header、sequence、parity、merge metadata の検証を必要とするため、jsQR lane は decoder merge support を主張せず `skipped` として扱います。

## Optional CLI Decoder Adapter

optional CLI decoder adapter は、local machine に外部 command がある場合だけ実行する decoder lane です。現在は `zbarimg` と ZXing CLI family (`ZXingReader`, `zxing`, `zxing-cpp`, `zxingscan`) を対象にします。これらの command は `package.json` の dependency ではなく、CI や contributor machine に必須ではありません。

optional adapter は最初に command availability を確認します。command が見つからない、または実行可能ではない場合、vector ごとに `status: "skipped"` を返し、`checks` に `availability` skip reason を入れます。この skip は expected skip であり、overall badge や CI を red にしません。

command が見つかった場合、adapter は SpecQR published package で PNG を生成し、CLI にその PNG path を渡します。`expect.decode.text` がある vector では、CLI から保守的に取り出した payload text と完全一致で比較します。payload が異なる、または command が decode できない場合は `failed` とします。

CLI decoder output は tool と version によって形式が異なるため、parser は conservative にします。`expect.decode.binaryHex` は raw byte として信頼できる CLI output がない限り `decode.binaryHex` check を `skipped` にします。optional CLI decoder adapter は Structured Append metadata validation、scanner metadata exposure、decoder merge support を主張しません。

## Reference Matrix Adapter

reference matrix adapter は、`expect.referenceMatrix` を持つ vector だけを対象にします。現在の Nayuki lane は `adapter: "nayuki"`, `exact: true`, `scope: "fixed-version-ecc-mask"` の expectation を読み、SpecQR と Nayuki の row-major matrix rows を完全一致で比較します。

Nayuki lane は `options.version`, `options.errorCorrectionLevel`, `options.maskPattern` が固定されている vector だけを実行します。固定条件がない vector、auto segmentation を含む vector、GS1/FNC1、Kanji、Structured Append は `skipped` とし、理由を `reason` に書きます。

失敗時は first mismatch の座標、期待 row、実 row、matrix hash を `details` に含めます。

## SpecQR Adapter の制約

SpecQR adapter は npm に公開された `specqr@2.4.0` を対象にします。SpecQR core repository の source tree や contributor の local checkout から source file を import せず、published package の公開 API だけを呼び出します。

SpecQR adapter は GS1 helper / Digital Link helper vector も実行できます。`expect.gs1.elementString`, `expect.gs1.validationSubset`, `expect.gs1.digitalLink`, `expect.gs1.normalized`, `expect.validation.ok` を評価し、validation error code は subset match として扱います。この範囲は SpecQR がサポートする AI subset の確認であり、GS1 full catalog の conformance ではありません。

SpecQR adapter は Structured Append helper vector も実行できます。`structuredAppend.generate`, `structuredAppend.generateSegments`, `structuredAppend.mergeParts` を published package に渡し、`expect.structuredAppend.total`, `parity`, `byteLength`, `inputLength`, `diagnosticsSubset`, `symbolsSubset`, `mergedSubset` を subset match として評価します。negative case は既存の `expect.rejects` を使います。

SpecQR adapter は Planning / Diagnostics vector も実行できます。`estimate`, `analyzeSegments`, `getCapacity` を published package に渡し、`expect.planning` の subset を評価します。Planning API の `{ ok: false, reason: "data-too-long" }` は non-throwing failure ですが、negative vector では `expect.rejects` と `expect.planning` を組み合わせて確認できます。warning は message text ではなく `code` の存在を確認します。

## 未実装時の扱い

現在の SpecQR adapter は published package `specqr@2.4.0` を実行します。jsQR adapter は decoder lane として active です。Nayuki adapter は fixed-condition reference matrix lane として active です。未実装 operation は `skipped` として report に記録します。adapter 本実装を入れるときは、schema validation を通過した vector だけを実行対象にします。
