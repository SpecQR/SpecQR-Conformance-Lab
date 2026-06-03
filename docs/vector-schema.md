# Vector Schema v1

この文書は SpecQR Conformance Lab の machine-readable vector schema v1 を定義します。adapter 実装者は、ここに書かれた suite / vector / expectation の形だけを前提にして実装します。

schema v1 の目的は、SpecQR を npm package として外部から検証し、同じ vector を jsQR や Nayuki などの adapter でも再利用できるようにすることです。SpecQR core repository の source file は import しません。

## 基本方針

- vector は JSON file として `vectors/` に置く。
- 1 file は 1 suite を表す。
- JSON object の unknown field は原則として許可する。ただし adapter が意味を解釈できない field に依存してはいけない。
- `input`, `options`, `expect` は必ず object にする。空の場合も `{}` を書く。
- 失敗を期待する negative case は、`expect.rejects` または `expect.validation` で明示する。
- binary input は `binaryHex` field に偶数長の hexadecimal string として書く。

## Suite Format

suite は次の field を必須とします。

```json
{
  "version": 1,
  "id": "core",
  "name": "Core QR vectors",
  "description": "QR Code Model 2 の基本生成 vector。",
  "category": "core",
  "vectors": []
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | number | yes | schema version。v1 では必ず `1`。 |
| `id` | string | yes | suite の安定 ID。file 名から独立してよい。 |
| `name` | string | yes | 人間向けの suite 名。 |
| `description` | string | yes | suite の目的と範囲。 |
| `category` | string | yes | `core`, `segments`, `planning`, `gs1`, `structured-append`, `negative` などの大分類。 |
| `vectors` | array | yes | vector object の配列。 |

`suite.id` は repository 内で一意にすることを推奨します。validator は v1 で `vector.id` の重複を全 file 横断で reject します。

## Vector Format

vector は次の field を必須とします。

```json
{
  "id": "core.byte.hello",
  "title": "Byte text generation",
  "category": "core",
  "operation": "generate",
  "input": {
    "text": "HELLO SPECQR"
  },
  "options": {
    "errorCorrectionLevel": "M"
  },
  "expect": {
    "decode": {
      "text": "HELLO SPECQR"
    }
  },
  "tags": ["byte"],
  "notes": "adapter は生成結果を decode expectation と比較する。"
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | lab 全体で一意な vector ID。report の主キーにも使う。 |
| `title` | string | yes | 人間向けの短い説明。 |
| `category` | string | yes | vector の大分類。suite category と同じでも、より細かくしてもよい。 |
| `operation` | string | yes | adapter が実行する operation enum。後述。 |
| `input` | object | yes | operation に渡す入力。 |
| `options` | object | yes | operation option。未使用でも `{}`。 |
| `expect` | object | yes | 期待結果。decode、matrix hash、diagnostics、reject など。 |
| `tags` | string[] | no | `byte`, `manual-segments`, `negative` などの検索用 tag。 |
| `notes` | string | no | 実装者向けの補足。report の判定には使わない。 |

## Operation Enum

v1 で許可する `operation` は次の値です。

| Operation | Input の主な形 | Meaning |
| --- | --- | --- |
| `generate` | `{ "text": "..." }` または `{ "binaryHex": "00ff" }` | 通常の QR generation。 |
| `generateSegments` | `{ "segments": [...] }` | manual segments を指定した generation。 |
| `estimate` | `{ "text": "..." }`, `{ "binaryHex": "..." }`, `{ "segments": [...] }` | Planning API の見積もり。 |
| `analyzeSegments` | `{ "segments": [...] }` | segment analysis。 |
| `getCapacity` | `{ "version": 1, "errorCorrectionLevel": "M" }` | capacity lookup。 |
| `gs1.createElementString` | GS1 element object | GS1 element string helper。 |
| `gs1.validateElementString` | `{ "elementString": "..." }` | GS1 element string validation。 |
| `gs1.createDigitalLink` | GS1 Digital Link parts | Digital Link helper。 |
| `gs1.validateDigitalLink` | `{ "url": "..." }` | Digital Link validation。 |
| `gs1.normalizeDigitalLink` | `{ "url": "..." }` | Digital Link normalization。 |
| `structuredAppend.generate` | `{ "text": "..." }` または `{ "binaryHex": "..." }` | Structured Append generation。 |
| `structuredAppend.generateSegments` | `{ "segments": [...] }` | Structured Append with manual segments。 |
| `structuredAppend.mergeParts` | `{ "parts": [...] }` | Structured Append merge helper。 |

adapter は未対応 operation を `skipped` として返してよい。ただし validator は enum 外の typo を reject します。

## Input Details

### Text Input

通常の文字列 input は `input.text` に書きます。

```json
{
  "operation": "generate",
  "input": {
    "text": "01234567"
  },
  "options": {
    "version": 1,
    "errorCorrectionLevel": "M",
    "maskPattern": 3
  }
}
```

### Binary Input

binary payload は `binaryHex` に書きます。validator は `binaryHex` が偶数長の hexadecimal string であることを検査します。

```json
{
  "operation": "generate",
  "input": {
    "binaryHex": "00ff"
  },
  "options": {}
}
```

`binaryHex` は `input.binaryHex` だけでなく、manual segment の中でも使えます。

### Manual Segments

manual segments は `input.segments` に配列で書きます。各 segment は `mode` と payload を持ちます。

```json
{
  "operation": "generateSegments",
  "input": {
    "segments": [
      { "mode": "numeric", "text": "12345" },
      { "mode": "alphanumeric", "text": "SPECQR" },
      { "mode": "byte", "binaryHex": "00ff" }
    ]
  },
  "options": {
    "errorCorrectionLevel": "Q"
  }
}
```

v1 では segment mode の詳細な意味は adapter 側で解釈します。validator は `segments` の中にある `binaryHex` も hex として検査します。

Kanji / ECI / binary vector では、manual Kanji segment や ECI control segment も同じ `segments` 配列で表します。ECI assignment の metadata は SpecQR diagnostics subset で確認し、reader lane では payload readability として観測できる範囲だけを確認します。

```json
{
  "operation": "generateSegments",
  "input": {
    "segments": [
      { "mode": "eci", "assignmentNumber": 26 },
      { "mode": "byte", "text": "こんにちは" }
    ]
  },
  "options": {
    "errorCorrectionLevel": "M"
  },
  "expect": {
    "diagnostics": {
      "subset": {
        "eciAssignmentNumber": 26,
        "segments": [
          { "mode": "eci", "assignmentNumber": 26 },
          { "mode": "byte", "byteCount": 15 }
        ]
      }
    },
    "decode": {
      "text": "こんにちは"
    }
  }
}
```

## Options

`options` は operation に渡す設定です。代表例は次の通りです。

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | QR version を固定する場合に使う。 |
| `errorCorrectionLevel` | string | `L`, `M`, `Q`, `H` のいずれかを想定する。 |
| `maskPattern` | number | mask pattern を固定する場合に使う。 |
| `eci` | number / string | ECI 指定が必要な vector で使う。 |
| `minVersion` | number | planning / generation の下限 version。 |
| `maxVersion` | number | planning / generation の上限 version。 |

validator v1 は options の domain validation を最小限に留めます。adapter は未対応 option を理由付き `skipped` にできます。

## Expectation Details

`expect` は object です。1 つの vector に複数の expectation を置けます。

### Decode Expectation

生成した QR が decode されたときの payload を表します。

```json
{
  "expect": {
    "decode": {
      "text": "HELLO SPECQR",
      "binaryHex": "00ff"
    }
  }
}
```

adapter が reader を持たない場合は、この expectation を `skipped` にしてよいです。

### Matrix Hash Expectation

matrix の安定比較用 hash を表します。`value` は lowercase hexadecimal を推奨します。

```json
{
  "expect": {
    "matrixHash": {
      "algorithm": "sha256",
      "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "encoding": "row-major-bits"
    }
  }
}
```

hash の入力形式は `encoding` で明示します。v1 の推奨値は `row-major-bits` です。

`row-major-bits` は、matrix の各 row を左から右へ `true = "1"`, `false = "0"` として文字列化し、row 同士を `\n` で連結した UTF-8 文字列を hash 入力にします。`algorithm: "sha256"` の場合は、その文字列の SHA-256 digest を lowercase hexadecimal で比較します。

### Diagnostics Subset Expectation

adapter が返す diagnostics の一部だけを比較したい場合に使います。

```json
{
  "expect": {
    "diagnostics": {
      "subset": {
        "version": 1,
        "errorCorrectionLevel": "M",
        "maskPattern": 3
      }
    }
  }
}
```

`subset` は「少なくともこの key/value を含む」ことを意味します。adapter result に追加 field があっても failure にはしません。

### Reference Matrix Expectation

外部 reference implementation と matrix を完全一致で比較する場合に使います。v1 で定義する最初の reference lane は Nayuki です。

```json
{
  "expect": {
    "referenceMatrix": {
      "adapter": "nayuki",
      "exact": true,
      "scope": "fixed-version-ecc-mask"
    }
  }
}
```

`referenceMatrix` を持つ vector は、`operation` が `generate` または `generateSegments` でなければなりません。また `options.version`, `options.errorCorrectionLevel`, `options.maskPattern` を固定する必要があります。`maskPattern` は `0` から `7` の整数だけを許可します。

`scope: "fixed-version-ecc-mask"` は、Version / ECC / mask が固定された QR matrix の exact match だけを主張します。GS1、Kanji、Structured Append、renderer output、auto segmentation の同等性はこの scope では主張しません。

### Planning / Diagnostics API Expectation

`estimate`, `analyzeSegments`, `getCapacity` などの Planning API 系 operation に使います。

```json
{
  "expect": {
    "planning": {
      "ok": true,
      "selectedVersion": 1,
      "errorCorrectionLevel": "M",
      "mode": "byte",
      "dataBitLength": 108,
      "capacityBits": 128,
      "remainingBits": 20
    }
  }
}
```

`planning` の中身は operation ごとに必要な subset を書きます。adapter は exact match ではなく subset match として扱います。`estimate` / `analyzeSegments` では `ok`, `reason`, `selectedVersion`, `minVersion`, `maxVersion`, `errorCorrectionLevel`, `mode`, `dataBitLength`, `capacityBits`, `remainingBits`, `overflowBits` などを比較できます。`getCapacity` では `version`, `size`, `dataCodewords`, `payloadBits`, `maxBytes`, `maxCharacters` など、返却 object の subset を同じ `planning` expectation に書けます。

diagnostics の一部を確認したい場合は `planning.diagnostics.subset` を使います。

```json
{
  "expect": {
    "planning": {
      "diagnostics": {
        "subset": {
          "phase": "planning",
          "renderPlanned": false,
          "maskEvaluated": false,
          "segments": [
            {
              "mode": "byte",
              "byteCount": 12
            }
          ]
        }
      }
    }
  }
}
```

warnings は message text を固定せず、code の存在を subset として確認します。

```json
{
  "expect": {
    "planning": {
      "warnings": [
        {
          "code": "QUIET_ZONE_TOO_SMALL"
        },
        {
          "code": "SCAN_RISK"
        }
      ]
    }
  }
}
```

capacity overflow は Planning API では throw せず `{ "ok": false, "reason": "data-too-long" }` を返します。v1 ではこの non-throwing failure も `expect.rejects` で negative case として表せます。

```json
{
  "expect": {
    "rejects": {
      "code": "DATA_TOO_LONG",
      "reason": "data-too-long"
    },
    "planning": {
      "ok": false,
      "overflowBits": 340
    }
  }
}
```

### GS1 / Digital Link Expectation

GS1 helper や Digital Link helper の結果を表します。この suite は published `specqr@2.4.0` が実装する GS1 AI subset を外部から確認するものであり、GS1 AI catalog 全体の conformance を主張しません。

```json
{
  "expect": {
    "gs1": {
      "elementString": "0104912345678904"
    }
  }
}
```

`expect.gs1` では次の field を使えます。

| Field | Type | Meaning |
| --- | --- | --- |
| `elementString` | string | `gs1.createElementString` が返す raw element string。 |
| `validationSubset` | object | `gs1.validateElementString` または `gs1.validateDigitalLink` の結果 subset。 |
| `digitalLink` | string | `gs1.createDigitalLink` が返す URL。 |
| `normalized` | string | `gs1.normalizeDigitalLink` が返す deterministic URL。 |

validation helper が成功する case では `expect.gs1.validationSubset` を使い、必要な subset だけを書きます。adapter result に追加 field があっても failure にはしません。

```json
{
  "expect": {
    "gs1": {
      "validationSubset": {
        "ok": true,
        "elements": [
          { "ai": "01", "value": "04912345678904" }
        ]
      }
    }
  }
}
```

Digital Link helper は URL の作成、検証、正規化を個別の operation として扱います。

```json
{
  "expect": {
    "gs1": {
      "digitalLink": "https://id.gs1.org/01/04912345678904/10/ABC123?17=251231",
      "normalized": "https://id.gs1.org/01/04912345678904/10/ABC123?17=251231&linkType=all"
    }
  }
}
```

validation helper の negative case では `expect.validation` を使います。

### Validation Expectation

validate 系 operation の結果、または negative case の明示に使います。

```json
{
  "expect": {
    "validation": {
      "ok": false,
      "errors": [
        {
          "code": "GS1_MISSING_SEPARATOR"
        }
      ]
    }
  }
}
```

validator は `expect.validation` がある場合、`valid` または `ok` のどちらかが boolean であることを検査します。SpecQR GS1 helper は `ok` を返すため、GS1/Digital Link vector では `ok` を優先します。

`errors` と `warnings` は exact full-object match ではなく、配列内に期待した subset が含まれるかを確認します。error code だけを固定したい場合は次のように書けます。

```json
{
  "expect": {
    "validation": {
      "ok": false,
      "errors": [
        {
          "code": "GS1_INVALID_CHECK_DIGIT"
        }
      ]
    }
  }
}
```

### Structured Append Expectation

Structured Append helper の結果を表します。この lab では SpecQR adapter が `generateStructuredAppend()`, `generateSegmentsStructuredAppend()`, `mergeStructuredAppendParts()` を published `specqr@2.4.0` から実行します。scanner から Structured Append metadata を読む実装や decoder merge support は、この lab の現在の検証範囲外です。

```json
{
  "expect": {
    "structuredAppend": {
      "total": 2,
      "parity": 65,
      "byteLength": 31,
      "inputLength": 31,
      "diagnosticsSubset": {
        "splitStrategy": "greedy-largest-fitting"
      },
      "symbolsSubset": [
        {
          "diagnostics": {
            "structuredAppend": {
              "index": 1,
              "total": 2,
              "parity": 65
            }
          }
        }
      ]
    }
  }
}
```

`expect.structuredAppend` では次の field を使えます。

| Field | Type | Meaning |
| --- | --- | --- |
| `total` | number | Structured Append set の symbol 数。 |
| `parity` | number | logical message bytes から計算された XOR parity。 |
| `byteLength` | number | logical input の byte 長。 |
| `inputLength` | number | string/binary では input length、manual segments では segment count。 |
| `diagnosticsSubset` | object | summary diagnostics の subset。 |
| `symbolsSubset` | array | `symbols` 配列の subset。主に各 symbol の `diagnostics.structuredAppend` を確認する。 |
| `mergedSubset` | object | `mergeStructuredAppendParts()` result の subset。 |

`mergeStructuredAppendParts()` の positive case では `mergedSubset` を使います。これは metadata-returning decoder が返した `{ index, total, parity, data }` parts を helper に渡した後の検証であり、jsQR が Structured Append metadata を返すことは主張しません。

```json
{
  "expect": {
    "structuredAppend": {
      "mergedSubset": {
        "data": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "diagnostics": {
          "parityCheck": {
            "matches": true
          }
        }
      }
    }
  }
}
```

negative case は既存の `expect.rejects` を使います。

```json
{
  "expect": {
    "rejects": {
      "code": "INVALID_INPUT",
      "messageIncludes": "missing index"
    }
  }
}
```

jsQR lane は readable payload の decode 確認だけを目的にします。Structured Append header、sequence、parity、merge metadata の検証は行いません。Nayuki lane も固定 Version/ECC/mask の single-symbol matrix 比較だけを扱い、Structured Append は対象外として `skipped` にします。

### Reject Expectation

operation が例外や reject を返すこと自体を期待する場合に使います。

```json
{
  "expect": {
    "rejects": {
      "code": "DATA_TOO_LONG",
      "messageIncludes": "too long"
    }
  }
}
```

`tags` に `negative` または `reject` を含める vector、または `category` が `negative` / `reject` を含む vector は、`expect.rejects` または `expect.validation` のどちらかを必ず持たなければなりません。

## Failure Handling

validator は schema に違反した vector を reject します。エラー message には file path と vector id、または vector id が未確定なら vector index を含めます。

adapter 実行時の扱いは次の方針です。

- schema 違反: `npm run validate:vectors` が失敗する。adapter は実行しない。
- 未対応 operation: adapter result は `skipped`。
- 期待値不一致: adapter result は `failed`。
- 実行中の例外: `expect.rejects` が合えば `passed`、合わなければ `error` または `failed`。
- negative case に `expect.rejects` / `expect.validation` がない: validator が失敗する。

## Minimal Complete Example

```json
{
  "version": 1,
  "id": "example",
  "name": "Schema example",
  "description": "schema v1 の最小例。",
  "category": "core",
  "vectors": [
    {
      "id": "example.generate.byte",
      "title": "Byte text generation",
      "category": "core",
      "operation": "generate",
      "input": {
        "text": "HELLO SPECQR"
      },
      "options": {
        "errorCorrectionLevel": "M"
      },
      "expect": {
        "decode": {
          "text": "HELLO SPECQR"
        },
        "diagnostics": {
          "subset": {
            "errorCorrectionLevel": "M"
          }
        }
      },
      "tags": ["byte"]
    }
  ]
}
```
