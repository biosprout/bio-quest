# BIO QUEST 問題データ仕様（Academic つむぎ向け）

更新日: 2026-09-03

このアプリは智穂子専用の生物クイズ PWA。JBO 本選通過済みで、次の目標は日本代表選抜。
生物学の知識を IBO 水準まで広げることが当面の目的。

**このドキュメントの範囲**: つむぎが新規問題を安全に追加するために必要な仕様だけ。
アプリ全体の設計書ではない。UI・学習履歴・レベル構成・分野構成は現状維持で、汎用教材システムへの
改造はしない。

## 1. source of truth

| 項目 | 値 |
|---|---|
| repository | `biosprout/bio-quest`（GitHub） |
| branch | `main` |
| source of truth | `index.html` 内の `const Q=[...]`（1 問 1 行） |
| local repo | `/Users/yucci/Documents/apps/bio-quest` |

問題データは JSON ファイルに分離していない。**`index.html` が唯一の source of truth**。
つむぎが読む `questions.json` は、そこから機械抽出した読み取り専用の写しであって、原本ではない。

`data/*.json` への移行はしない（他の BioSprout アプリとは方針が違う）。

## 2. 問題 schema

```js
{id:'c_e1',f:'cell',lv:'easy',q:'原核細胞に「ない」ものはどれか。',ch:['細胞膜','リボソーム','核膜','DNA'],a:2,ex:'原核細胞は核膜に包まれた核をもたない。...'}
```

| key | 型 | 内容 |
|---|---|---|
| `id` | string | 問題 ID。§5 の規則に従う。公開後は変更・再利用しない |
| `f` | string | 分野。§3 の 8 種類のいずれか |
| `lv` | string | レベル。§4 の 4 種類のいずれか |
| `q` | string | 問題文。1 問 1 文が基本 |
| `ch` | string[] | 選択肢。**必ず 4 個**。重複禁止 |
| `a` | number | 正答の index。**0 始まり**（0-3） |
| `ex` | string | 解説。必須。空にしない |

- property はこの 7 個で過不足なく、この順序で書く。補助 property を足さない。
- 文字列は制御文字を含めない。`</script` を含めない（`index.html` の script タグ内に直接
  埋め込むため、ページが壊れる）。
- HTML タグは書かない。表示側で escape されるのでタグとしては機能せず、そのまま文字として出る。
- 改行は入れない（1 問 1 行を維持するため）。

## 3. `f`（分野）の一覧

| f | 表示名 | 範囲の目安 |
|---|---|---|
| `cell` | 細胞・細胞小器官 | 細胞構造、膜輸送、細胞骨格、細胞周期、細胞分裂 |
| `meta` | 代謝・酵素 | 酵素反応、呼吸、発酵、光合成の生化学、ATP、代謝調節 |
| `gene` | 遺伝・遺伝子 | メンデル遺伝、連鎖と組換え、集団遺伝、染色体、遺伝子相互作用 |
| `mol` | 分子生物学 | DNA 複製、転写、翻訳、遺伝子発現調節、バイオテクノロジー |
| `body` | 動物の体・生理 | 神経、筋、循環、呼吸、消化、腎、内分泌、免疫、恒常性、発生 |
| `plant` | 植物の生理 | 光合成の生理、水分通道、植物ホルモン、光形態形成、花成、植物の構造 |
| `eco` | 生態・環境 | 個体群、群集、生態系、物質循環、生物多様性、保全 |
| `evo` | 進化・分類 | 進化機構、系統、分類、生命の起源、生物地理、行動生態 |

分野の追加・削除・名称変更はしない（アプリの UI とアイコン `FICON` に直結する）。

## 4. `lv`（レベル）の一覧

| lv | 表示名 | 位置づけ | 現在の狙い |
|---|---|---|---|
| `easy` | やさしい | 高校基礎 | 用語と基本概念の確認 |
| `std` | 標準 | 高校発展 | 教科書発展レベル、典型的な因果関係 |
| `hard` | 難しい | 大学初級 | 大学教養の生物学、定量的推論の入口 |
| `ibo` | IBO 級 | 代表選抜水準 | 実験解釈、データ読み、複数概念の統合 |

レベルの追加・削除はしない。

**難易度の判定はつむぎの担当**。なぎ側は `lv` の値が有効かどうかしか見ない。

## 5. ID の命名・採番規則

形式: `<分野 prefix>_<レベル文字><番号>`

分野 prefix:

| f | prefix | | f | prefix |
|---|---|---|---|---|
| `cell` | `c` | | `body` | `b` |
| `meta` | `m` | | `plant` | `p` |
| `gene` | `g` | | `eco` | `e` |
| `mol` | `mo` | | `evo` | `v` |

レベル文字: `easy` = `e` / `std` = `s` / `hard` = `h` / `ibo` = `i`

番号: 1 始まりの整数。ゼロ埋めしない（`c_e9` であって `c_e09` ではない）。

例: `c_e1`（細胞・やさしい・1 番）、`mo_i21`（分子生物学・IBO 級・21 番）

採番の手順:

1. `questions.json` の `next_id` を見る。分野 x レベルごとに「次に使う ID」が計算済み。
2. `next_id` から連番で振る。
3. **欠番は埋めない**。番号は各系列の最大値 + 1 から始める。
4. 同じ受け渡しサイクルで作った未取込 batch の ID も使用済みとして扱う。
5. 公開済みの ID を別の問題に再利用しない。ID と問題文は 1 対 1。

ID は学習履歴（`localStorage` の `state.stats[id]`）の key でもある。**既存 ID の意味を変えると、
智穂子の学習記録がその問題に紐づいたまま中身だけ入れ替わる**。だから ID の使い回しは禁止。

## 6. `a`（answer index）と選択肢シャッフルの関係

- `a` は **`ch` 配列の 0 始まり index**。`ch[a]` が正答。
- アプリは出題のたびに選択肢を**シャッフルして表示する**（`shuffle(q.ch.map((c,k)=>({c,k})))`）。
  ただし各ボタンは元の index `k` を保持し、`k === q.a` で正誤を判定する。
  **つまり `a` は常にデータ上の並び順を指す。表示順は関係ない。**
- 帰結として、つむぎ側が守るべきこと:
  - 正答の位置を散らす配慮は不要（表示時に毎回混ざる）。`a` はデータとして自然な位置でよい。
  - **順序に依存する選択肢を書かない**。「上記すべて」「1 と 3」「いずれでもない」は、
    シャッフルで位置が変わるため使用禁止。
  - 選択肢どうしを「ア、イ、ウ」などの記号で参照しない。
  - 正答は 1 つだけ。部分的に正しい選択肢を残さない。

## 7. 重複禁止ルール

なぎ側の取込ツールが機械的に弾くもの:

1. **ID の重複** — 既存全問題および同一 batch 内。
2. **問題文の完全一致** — NFKC 正規化 + 空白畳み込みで比較。既存全問題および batch 内。
3. **同一問題内の選択肢の重複** — 同じく正規化して比較。

機械では判定できないため、**つむぎ側の責任**になるもの:

4. **意味的な重複** — 表現が違うだけで問う内容が同じ問題。
   例: 「ミトコンドリアの働きは」と「ATP を主に合成する細胞小器官は」。
   `questions.json` の全 `items` を読んでから作ること。分野 x レベルの近傍だけ見て判断しない。
5. **同じ知識点の過剰な繰り返し** — 1 つの知識点に対する問題は、レベルを変えて 2-3 問までを目安に。
6. **解説の使い回し** — 別問題に同じ解説文を貼らない。

## 8. アプリ固有の validation 条件

`node scripts/validate-content.mjs` が確認する。error があると snapshot 更新も batch 取込も止まる。

error（取込不可）:

- `const Q=[...]` が JS として parse できない
- property が `id,f,lv,q,ch,a,ex` の順で過不足なく揃っていない
- `f` / `lv` が未定義の値
- `id` が重複、または `<prefix>_<レベル文字><番号>` の形式と `f` / `lv` が食い違う
- `ch` が 4 個でない / 選択肢が重複 / 空文字
- `a` が整数でない、または範囲外
- `q` / `ex` が空
- 文字列に制御文字または `</script` が含まれる
- 問題文が完全一致で重複している
- **分野 x レベルの組み合わせが 1 つでも 0 件になる**
  （アプリでその分野とレベルを選ぶと出題できずに止まるため）
- 1 問 1 行の書式から外れていて、ツールが同じ形で書き戻せない

warning（取込は可能）:

- 字下げが 2 スペースでない行がある
- 表示文言の総問題数（`index.html` の使い方ガイド、`manifest.json` の description）が
  実データとずれている。次の batch 取込時に自動更新される
- `FICON` に分野のアイコンがない

## 9. つむぎ -> なぎ の batch 形式

置き場所: Google Drive `biosprout-content/20_ready/<batch_id>.json`

他教科と同じ受け渡しフォルダを使う（`20_ready/` は subject 別のサブフォルダを作らない flat 構成。
`batch_id` に `bio-quest` が入っているので取り違えない）。作成途中は `10_drafts/`、
なぎが取込中は `30_processing/`、取込後は report と一緒に `40_done/` へ移動する。

ファイル名は `<batch_id>.json`。`batch_id` はファイル名と一致させる。

```json
{
  "schema_version": 1,
  "batch_id": "2026-09-07_bio-quest_001",
  "status": "ready",
  "subject": "bio-quest",
  "purpose": "weekly_increment",
  "generated_at": "2026-09-07T09:00:00+09:00",
  "generated_by": "tsumugi",
  "source": {
    "repo": "biosprout/bio-quest",
    "branch": "main",
    "commit": "snapshot の _SNAPSHOT_READY.json に書かれた commit",
    "content_spec": "CONTENT_SPEC.md",
    "snapshot_captured_at": "2026-09-07T08:50:00+09:00",
    "counts": { "total": 336 }
  },
  "expected_count_before": 336,
  "items": [
    {
      "id": "p_e6",
      "f": "plant",
      "lv": "easy",
      "q": "...",
      "ch": ["...", "...", "...", "..."],
      "a": 1,
      "ex": "..."
    }
  ],
  "qa": {
    "schema_checked": true,
    "id_unique_against_current_data": true,
    "exact_question_duplicate_checked": true,
    "semantic_duplicate_checked": true,
    "single_correct_answer_checked": true,
    "distractor_quality_checked": true,
    "explanation_checked": true,
    "factual_accuracy_checked": true,
    "level_appropriateness_checked": true
  }
}
```

決まりごと:

- **`items` には新規問題だけを入れる**。既存問題の修正・削除は batch に混ぜない
  （直したい既存問題がある場合は、batch とは別に「この ID をこう直したい」と文章で申し送る）。
- `status` が `ready` のものだけ取り込む。作成途中は `10_drafts/` に置く。
- `source.commit` は snapshot marker の commit をそのまま書く。HEAD と違うと取込が止まる
  （最新 snapshot で ID と重複を再確認してから、なぎが `--allow-stale` で続行する）。
- `expected_count_before` は snapshot 時点の総問題数。ずれていたら止まる。
- `qa` の boolean は、つむぎが実際に確認した項目だけ `true` にする。1 つでも `false` だと取り込まない。
- 生成途中の不完全なファイルを `20_ready/` に置かない。

## 10. なぎ側の取込

```bash
cd /Users/yucci/Documents/apps/bio-quest
node scripts/import-question-batch.mjs <batch.json>            # dry run（既定）
node scripts/import-question-batch.mjs <batch.json> --apply    # 追記
```

取込時に自動で行うこと:

- `index.html` の `const Q=[...]` 末尾へ追記（既存行は 1 行も書き換えない）
- `APP_VER` を更新（アプリの更新確認バーはこの値の変化で出る。更新しないと智穂子の端末に届かない）
- 表示文言の総問題数を実データに合わせる（`index.html` と `manifest.json`）
- validator 実行。失敗したら `index.html` と `manifest.json` を元のバイト列へ戻す

**なぎは問題文・選択肢・解説を書き換えない**。誤字レベルでも勝手に直さず、つむぎへ差し戻す。
commit までがなぎの担当で、GitHub への push は田中が行う。

## 11. 参考: つむぎが読むファイル

Google Drive `biosprout-content/05_current_snapshot/bio-quest/`

| file | 内容 |
|---|---|
| `_SNAPSHOT_READY.json` | `status` が `ready` のときだけ使う。commit と件数と validator 結果 |
| `questions.json` | 現在の全問題、分野 x レベル件数、`next_id` |
| `CONTENT_SPEC.md` | このファイルの写し |

`status` が `ready` でない、または marker が無いときは snapshot を使わない（更新途中）。
snapshot を直接編集しない。

---

# 既存問題の修正（correction）

追記（append）とは別の経路。ID と智穂子の学習履歴を保ったまま、既存問題の中身だけを差し替える。

## 12. 何を変えられるか

| field | 変更 |
|---|---|
| `q` `ch` `a` `ex` | 変更できる |
| `id` | **不可**。`localStorage` の学習履歴の key であり、公開済み ID は再利用しない |
| `f` `lv` | **不可**。分野やレベルを動かすときは別途 migration を設計する |

- `set` に書かなかった field は現状維持。
- 問題数は変わらない。
- 取込ツールは `reasons` や hash を `index.html` に書き込まない。
- 修正後も §8 の validation 条件をすべて満たす必要がある（選択肢 4 個、`a` の範囲、
  問題文の完全一致禁止、分野×レベルが 0 件にならない、など）。

## 13. `expected_item_sha256`

対象 item を取り違えないための指紋。

`id, f, lv, q, ch, a, ex` をこの順に並べた object を `JSON.stringify` して、その UTF-8 文字列の
SHA-256 を hex で取る（`scripts/lib/questions.mjs` の `itemSha256`）。

つむぎは自分で計算せず、snapshot の `questions.json` にある `item_sha256` の値をそのまま使えばよい。

- 1 件でも hash が一致しないと、その item だけ飛ばすのではなく **batch 全体を中止**し、
  ID・期待値・実際の値を表示する。
- `source.commit` が repo の HEAD と違っていても、対象 item の hash が全件一致すれば取り込める
  （問題データに関係のない commit が挟まっているだけのため）。
- 書き込み直前にもう一度、現在のファイルから hash を取り直して確認する。

## 14. correction batch の形式

置き場所は追加 batch と同じ `20_ready/<batch_id>.json`。`purpose` は `quality_correction`。

```json
{
  "schema_version": 1,
  "batch_id": "2026-09-04_bio-quest_correction_001",
  "status": "ready",
  "subject": "bio-quest",
  "purpose": "quality_correction",
  "generated_at": "2026-09-04T15:00:00+09:00",
  "generated_by": "tsumugi",
  "source": {
    "repo": "biosprout/bio-quest",
    "branch": "main",
    "commit": "snapshot marker の commit",
    "content_spec": "CONTENT_SPEC.md",
    "snapshot_captured_at": "snapshot marker の captured_at",
    "counts": { "total": 416 }
  },
  "expected_count_before": 416,
  "updates": [
    {
      "id": "v_i20",
      "expected_item_sha256": "questions.json の item_sha256 の値",
      "set": { "ch": ["...", "...", "...", "..."], "a": 0, "ex": "..." },
      "reasons": ["choice_length_cue", "explanation_accuracy"]
    }
  ],
  "qa": {
    "schema_checked": true,
    "id_and_hash_checked": true,
    "single_correct_answer_checked": true,
    "choice_parallelism_checked": true,
    "choice_length_cue_checked": true,
    "explanation_checked": true,
    "factual_accuracy_checked": true,
    "level_appropriateness_checked": true,
    "notes": []
  }
}
```

`items` と `updates` は同じ batch に混ぜない。追加 batch は `items`、修正 batch は `updates`。
どちらのツールも取り違えを拒否する。

## 15. 取込

```bash
cd /Users/yucci/Documents/apps/bio-quest
node scripts/import-question-corrections.mjs <batch.json>            # dry run（既定）
node scripts/import-question-corrections.mjs <batch.json> --apply    # 適用
node scripts/import-question-corrections.mjs <batch.json> --report <out.md>
```

dry run は ID ごとに、問題文・選択肢・正答文字列・解説の before / after、選択肢長 `[l0,l1,l2,l3]`、
正答の長さ順位、単独最長・単独最短、2 位との差と比、変更した field を出す。

適用時は該当行だけを差し替え（他の行は 1 文字も触らない）、`APP_VER` を更新し、validator を実行する。
validator が失敗したら `index.html` と `manifest.json` を byte 単位で元へ戻す。

## 16. 選択肢の品質基準

`node scripts/audit-question-quality.mjs` が機械的に測るのは長さだけで、内容の判断はつむぎが行う。

- 長さは Unicode コードポイント数で測る。
- 「正答が単独最長」は 4 択のうち正答だけが最大長のもの。
- ランダム期待は **単独最長が存在する問題数 ÷ 4**。同長 tie の問題では単独最長が存在しないので、
  総問題数の 25% を期待値にしない。
- strong flag は、正答が単独最長かつ、2 位より 4 文字以上長い、または 1.20 倍以上長いもの。

flag はレビューの優先順位づけにだけ使う。機械的に文字数を揃えたり、自動で書き換えたりしない。

つむぎが確認すること:

- 4 択の文法形式が並列である。
- 情報粒度と限定条件が同程度である。
- 正答だけに理由・括弧書き・数値・例外条件が付いていない。
- 誤答も同じ topic のもっともらしい誤概念である。
- 長さを合わせるためだけの不自然な冗長化をしない。
- 正答が常に最長・最短になることは避けるが、個別の問題で自然に長くなることまでは禁じない。
- 「上記すべて」「1 と 3」「いずれでもない」など表示順に依存する選択肢は禁止（§6 参照）。

## 17. 解説の品質基準

audit が review queue に入れるもの（誤りの断定ではない）:

| flag | 意味 |
|---|---|
| `short_explanation` | 30 文字未満 |
| `restates_answer_only` | 正答の言い換えに近く、理由や機序の語がない |
| `absolute_wording` | 必ず / 常に / 完全に / のみ など強い限定語を含む。「正常に」「非常に」のような部分一致と、「〜とは限らない」のような否定を伴う用法は除く |
| `numeric_claim` | 数値と単位を含み、事実確認が要る |
| `scope_generalization_candidate` | 問題文が生物群や条件を限定しているのに、解説に限定語がない |

つむぎの解説基準:

1. まず、なぜ正答なのかを明示する。
2. 必要に応じて因果機序または計算過程を書く。
3. 成立する生物群・組織・発生段階・実験条件を限定する。
4. 重要な誤答が紛らわしいときだけ、なぜ違うかを補足する。
5. 「主に」「一般に」「多くの場合」を適切に使い、例外のある現象を断定しない。
6. easy / std は簡潔に、hard / ibo は理解に必要な機序まで書く。
7. 表面的に長くするのではなく、正確さと学習価値を優先する。

## 18. レビュー台帳

`biosprout-content/00_specs/quality/bio-quest-review-status.json`。app のデータとは分けて管理する
つむぎの監査台帳で、source of truth ではない。

- `choice_status` / `explanation_status`: `pending` / `verified` / `revised` / `needs_source_check`
- `reviewed_by` / `reviewed_at` / `notes` は人が書く
- `item_sha256` / `machine_flags` / `stale_since_review` は `bioquest_review_status.mjs` が更新する
- レビュー済みの問題が後から修正されると `stale_since_review` が立ち、再確認対象として浮く
