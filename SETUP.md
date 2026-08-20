# 新しいプロジェクトへの導入手順

所要 30〜60分（うち大半は `project-rules.md` を書く時間）。

---

## 1. ファイルを配置する

```sh
# このテンプレートを置いた場所を TEMPLATE に入れる
TEMPLATE=/path/to/planning-workflow-template

cd /path/to/your-project
cp -R "$TEMPLATE/template/." .
```

`template/` 直下の中身がそのままプロジェクト直下に入ります。

```
your-project/
├── CLAUDE.md                                  ← 新規（既にある場合は下記）
└── .claude/
    ├── hooks/check_plan_freshness.py
    └── workflows/
        ├── plan-survey.js
        ├── plan-feature.js
        ├── project-rules.md
        └── backlog.md
```

**既に `CLAUDE.md` がある場合**は上書きせず、テンプレートの
「まず読むもの」と「実装のたびに守ること」の節だけを追記してください。

---

## 2. フックを登録する

`.claude/settings.json` に `SessionStart` を追加します。ファイルが無ければ新規作成。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/check_plan_freshness.py\""
          }
        ]
      }
    ]
  }
}
```

既存の `hooks` がある場合は、`SessionStart` のキーだけを足してください。

---

## 3. フックをプロジェクトに合わせる

`.claude/hooks/check_plan_freshness.py` の**上部にある「▼ ここを書き換える」ブロック**を編集します。

```python
SRC_DIRS = ["src", "app", "lib"]          # 監視するディレクトリ
IGNORE = ("dist/", "node_modules/", ...)  # 無視するもの

LENS_MAP = [                              # パス → 古くなるレンズ
    ("src/api/",        ["wiring", "contracts"]),
    ("src/models/",     ["state"]),
    ("src/components/", ["ui"]),
]

CONTRACT_PAIRS = [                        # 片側だけ変えると壊れる組
    {"name": "API の型定義", "a": "src/server/", "b": ("src/client/types.ts",)},
]
```

`LENS_MAP` が空でもフックは動きます（追記の promptだけ出る）。後から足せます。

動作確認:

```sh
echo '{}' | python3 .claude/hooks/check_plan_freshness.py
```

---

## 4.（任意）レンズを調整する

`plan-survey.js` の `LENSES` に7本入っています。

| レンズ | 何を調べるか |
|---|---|
| `precedent` | 機能ごとに最も近い既存実装と、それが触る全ファイル ← **最重要** |
| `state` | データと設定の住処 |
| `wiring` | 新しい単位の登録経路（登録漏れで動かない箇所） |
| `contracts` | 層をまたぐ契約（文字列一致・型・スキーマ） |
| `crosscut` | エラー・認可・ログ・バリデーション・非同期 |
| `ui` | 画面の構造（**UI が無いプロジェクトでは外す**） |
| `verify-deploy` | 検証手段と出荷手順 |

**プロジェクト固有の関心軸は引数で足せます。** JS を編集する必要はありません。

```
/plan-survey  extraLenses: ['決済フローを、外部PSPとの通信・冪等性・失敗時の補償を軸に解剖する']
```

恒久的に足したいなら `LENSES` に追記してください。

UI が無いなら実行時に外します。

```
/plan-survey  lenses: ['precedent','state','wiring','contracts','crosscut','verify-deploy']
```

---

## 5. `project-rules.md` を書く ← **ここが本番**

**空のまま `plan-survey` を回さないでください。** 効果が大きく落ちます。

最低限、次の3節だけは埋めてください。

| 節 | なぜ重要か |
|---|---|
| **出荷の制約** | `plan-feature` がここを1項目ずつ引用して該当判定する（`deploy_impact.hazards`）。空だと出荷事故のチェックが働かない |
| **テストの現実** | 計画の `verification` の書き方が決まる。テストが無いなら「無い」と書く |
| **触ってはいけない決定** | 無いとエージェントが善意で「改善」してしまう |

残りの節は `plan-survey` を回した後、その結果を見ながら埋めれば十分です。

**注意: 「既知の欠陥」節にはセキュリティ上の問題を書くことがあります。
このファイルを公開リポジトリに置かないでください。**

---

## 6. `backlog.md` を書く

資料に**書かれていることだけ**を写します。実装方法は書きません。

**機能キーの表は必ず埋めてください。** `/plan-feature <キー>` で使います。

---

## 7. 回す

```
/plan-survey
```

出力:
- `docs/plan/repo-baseline.md` — コードの地図
- `docs/plan/regression-checklist.md` — 回帰確認の手順書
- `docs/plan/feature-order.md` — 依存関係・着手順・**着手前に答えるべき問い**
- `docs/plan/.baseline-commit` — 鮮度チェック用の基準コミット

`feature-order.md` の `blocking_questions` に答えてから、機能ごとの計画に進みます。

```
/plan-feature <キー>
```

---

## チェックリスト

```
- [ ] template/ の中身をプロジェクト直下にコピーした
- [ ] .claude/settings.json に SessionStart を登録した
- [ ] check_plan_freshness.py の SRC_DIRS / IGNORE / LENS_MAP を書き換えた
- [ ] フックが動くことを確認した
- [ ] UI が無いプロジェクトなら ui レンズを外す方針を決めた
- [ ] project-rules.md の「出荷の制約」「テストの現実」「触ってはいけない決定」を埋めた
- [ ] backlog.md の機能キー表を埋めた
- [ ] CLAUDE.md の1行目・概要・「特に事故が多い点」を埋めた
- [ ] docs/plan/ を .gitignore していないことを確認した（計画はコミットする）
- [ ] project-rules.md に機微情報を書くなら、リポジトリが private であることを確認した
```
