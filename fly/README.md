# fly — ショウジョウバエ全脳モデルをボットから引く

成虫ショウジョウバエの全脳コネクトーム (FlyWire v783, 138,639 ニューロン / 15,091,983 結合) を
漏れ積分発火 (LIF) で GPU 上に走らせ、HTTP で「感覚を入れて、行動系ニューロンの発火率を読む」
ための小さなサービス。モデルは Shiu et al. 2024 *Nature* "A Drosophila computational brain model
reveals sensorimotor processing" の Brian2 実装を PyTorch に移したもの。

## 起動

```bash
python fly/server.py          # 127.0.0.1:8790 (FLY_PORT で変更)
python fly/validate.py        # 下の検証表を測り直す
```

- データは `FLY_DATA_DIR` (既定はリポジトリの隣の `../fly-data`)。`Completeness_783.csv`,
  `Connectivity_783.parquet`, `annotations.tsv` を置く。
- 初回は結合行列を作って `fly/.cache/` に保存する。2回目以降の起動は 1 秒程度。
- 必要なのは torch (CUDA) / numpy / pandas / pyarrow だけ。サーバーは標準ライブラリ。

## API

| | |
|---|---|
| `GET /health` | `{"ok":true,"neurons":138639,"synapses":15091983,"device":"cuda"}` |
| `GET /groups` | 入力チャンネルと読み出し群の細胞数・細胞型 |
| `POST /step` | `{"stimuli":{"sugar":1.0},"duration_ms":200}` → `rates`(群ごとの Hz), `input_rates`, `sim_ms`, `wall_ms`, `active_neurons`, `top_cell_types`(直接刺激した細胞を除いた発火数上位10型) |
| `POST /reset` | 膜電位・コンダクタンス・不応期・遅延バッファを初期化 |

- 刺激は 0..1 で、ポアソン入力 0..150 Hz に換算する。知らないチャンネルは 400。
- `duration_ms` は 10..2000 に丸める。
- **脳の状態はリクエストをまたいで続く。** 前の刺激の余韻が次の結果に入る。比べたいときは `/reset`。

## モデル (Shiu et al. 2024 の値のまま)

v_0 = v_rst = -52 mV, v_th = -45 mV, 膜時定数 20 ms, シナプス時定数 5 ms, 不応期 2.2 ms,
遅延 1.8 ms, 重み 0.275 mV × シナプス数 × 符号, ポアソン入力の重み 250 × 0.275 mV, dt = 0.1 ms。
遅延がちょうど 18 step なので、18 step 分の発火をまとめて 1 回の疎行列積で配る (逐次と同じ結果)。
その 18 step を CUDA Graph に録って流している。

## 入力チャンネル

| channel | 細胞 (annotations.tsv) | 数 |
|---|---|---|
| sugar | `cell_sub_class == sugar` (LB3c, 唇弁の糖 GRN) | 32 |
| bitter | `cell_sub_class == bitter` (LB1a–d) | 42 |
| water | `cell_sub_class == water` (LB3a) | 30 |
| looming_left / right | `cell_type` LPLC2 + LC4, `side` 別 | 162 / 152 |
| touch | ジョンストン器官 JO-C*, JO-E* (Shiu の "JO-CE": CA1, CA2, CL, CM, ED1, ED2_a–c, EV1–6) | 433 |
| odor | 果実・酢に誘引される ORN: DM1, DM2, DM4, VA2, VM2 (両側) | 266 |

odor は最初 left/right に分けたが、出力がほぼ同じだった (ORN は両側の触角葉へ投射する) ので 1 本にした。

## 読み出し群

| group | 細胞 | 数 | 根拠 |
|---|---|---|---|
| feed | 吻の運動ニューロン全部 (`proboscis_motor_neuron`, MxLbN) | 24 | MN9 という名前が注釈に無い。砂糖で発火した型だけを選ぶと検証にならないので全体の平均 |
| escape | DNp01 (giant fiber), DNp02, DNp04, DNp06, DNp11 | 10 | 迫る刺激に応じる DN |
| walk_forward | DNp09 (= P9) | 2 | oDN1 / BPN は注釈に無い |
| walk_backward | MDN (moonwalker) | 4 | |
| turn_left / right | DNa01, DNa02 の左 / 右 | 2 / 2 | 同側旋回 |
| groom | DNg29, DNb06, DNbe001, DNp40 | 8 | **touch の結果を見て選んだ。** Hampel 2015 の aDN の名前が注釈に無く、DNg12 は何を入れても 0 Hz だった |

## 検証 (RTX 4060 Ti, reset から 500 ms, 3 回平均, Hz)

| condition | feed | escape | walk_fwd | walk_back | turn_L | turn_R | groom | 発火した細胞 |
|---|---|---|---|---|---|---|---|---|
| (なし) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sugar | **26.8** | 0 | 0 | 0 | 0 | 0.3 | 0 | 420 |
| bitter | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 118 |
| water | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 96 |
| looming_left | 0.1 | **117.7** | 0.7 | 8.3 | 0 | **24.3** | 0 | 833 |
| looming_right | 1.9 | **109.3** | 0 | 23.5 | **48.7** | 0 | 0 | 894 |
| touch | 0 | 0.1 | 0 | 0 | 0 | 0 | 53.8* | 942 |
| odor | 0 | 3.5 | 0 | 0 | 43.0 | 2.0 | 12.5 | 10463 |
| sugar 0.5 | 12.6 | 0 | 0 | 0 | 0 | 0 | 0 | 309 |
| sugar + bitter | **0.3** | 0 | 0 | 0 | 0 | 0 | 0 | 249 |
| sugar + looming_L | 0.2 | 117.4 | 1.0 | 10.5 | 0 | 22.7 | 0 | 1058 |

\* groom は touch で発火する DN を選んだので、この値は作りの結果であって検証ではない。

読めること:
- **砂糖 → 吻の運動ニューロン** は Shiu et al. と同じく出る。強さに応じて上がる (0.5 で半分、0.3 だとほぼ 0)。
  砂糖で一番よく発火した吻の型は CB0871 (約 100 Hz)、CB0911。MN9 はこのどちらかの可能性が高い。
- **苦味は砂糖の摂食を消す** (26.8 → 0.3 Hz)。これも Shiu et al. と一致。迫る刺激でも摂食が止まる。
- **迫る刺激 → giant fiber ほかの逃避 DN** が強く出る。さらに **反対側への旋回** (左から迫ると turn_right)
  と後退 (MDN) も少し出る。逃げる向きとして筋が通っている。
- 何もしないと全く発火しない (自発活動の無いモデル)。
- **沈黙しているもの:** 前進 (DNp09) はどの刺激でもほぼ 0。water は読み出し群に何も出さない。bitter 単独も 0
  (抑える相手が居ないと見えない)。
- **odor は疑わしい:** 1 万個が発火し、左右どちらの ORN でも turn_left に出る。系の偏りであって
  「匂いのほうへ曲がる」ではない。
- **odor は収まらない (2026-10-01 追試):** 0.03 (4.5 Hz) でも約 1 万細胞の発火に落ち、入力を止めても
  9,900 細胞が発火し続けた。他の入力 (looming・touch・sugar・bitter) は止めて 0.6 秒で 0 に戻る。
  この持続状態では砂糖を入れても feed が 26.7 → 4.0 Hz に潰れる。ボット側 (`src/core/brain/fly-brain.ts`)
  は既定で odor を送らない (`FLY_ODOR=1` で送る)。

## 速さ

脳の 100 ms に実時間 約 200 ms (実時間の半分の速さ)。うち疎行列積が 2.4 ms × 55 回 ≈ 130 ms。
CUDA Graph 無しだと約 780 ms だった。dt = 0.1 ms のまま。`duration_ms` 200 なら約 0.4 秒待つ。
GPU メモリは約 200 MB (torch の確保量。CUDA の文脈ぶんは別)。キャッシュ `fly/.cache/w_csr_783.pt` は約 300 MB。

## 正直な注意

- **重みはシナプス数 × 神経伝達物質の予測符号であって、測った強さではない。** 全シナプス同じ 0.275 mV。
- **コネクトームは脳だけ。** 腹側神経索 (VNC) も脚も無いので、DN の発火は「そういう命令が下りた」という
  意味でしかない。実際に歩く・逃げる体は無い。
- **入力と出力の対応は手で決めた。** 細胞型の名前で選んでいて、MN9・aDN・oDN1 は注釈に名前が無いため
  近いもので代えている (上の表)。
- 刺激は「その感覚細胞を 150 Hz で叩く」という強い操作で、自然な感覚入力ではない。閾値的で、弱い刺激は
  何も起こさないことが多い。
- ポアソン入力なので同じ刺激でも毎回少し違う。
