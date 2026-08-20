export const meta = {
  name: 'plan-survey',
  description: 'リポジトリを複数のレンズで並列調査し、機能追加計画の共通土台と着手順を作る',
  whenToUse: '追加開発の最初に1回だけ実行する。出力 docs/plan/repo-baseline.md を plan-feature が参照する',
  phases: [
    { title: 'Survey',    detail: '関心軸ごとの並列調査' },
    { title: 'Baseline',  detail: '統合して docs/plan/repo-baseline.md に書き出す' },
    { title: 'Checklist', detail: '現行システムの回帰チェックリストを作る' },
    { title: 'Order',     detail: '機能間の依存関係・共有部品・推奨着手順' },
  ],
}

// ---------------------------------------------------------------- 参照資料
// 全エージェントに読ませる。ここを更新すればワークフローの前提が更新される。
const RULES   = '.claude/workflows/project-rules.md'
const BACKLOG = '.claude/workflows/backlog.md'
const OUT_DIR = 'docs/plan'

const cfg = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
const num = (v, d) => (typeof v === 'number' ? v : d)
const MAX_EXTRA = num(cfg.maxExtraLenses, 4)

// lenses: ['ui', 'contracts'] のように渡すと、そのレンズだけ再調査する。
// 機能を実装してコードが変わった後、影響を受けた層だけ地図を更新したいときに使う。
const ONLY = Array.isArray(cfg.lenses) && cfg.lenses.length ? cfg.lenses : null

// done: ['feature-a'] のように実装済みの機能キーを渡すと、着手順から除外される。
const DONE = Array.isArray(cfg.done) ? cfg.done : []
if (DONE.length) log('実装済みとして着手順から除外: ' + DONE.join(', '))

// ------------------------------------------------------- 書き込みの安全装置
// 調査フェーズのエージェントは読み取り専用にする（Edit / Write を持たせない）。
// ファイルを書くのは Baseline / Checklist / Order の3フェーズだけで、書き先は docs/plan/ のみ。
const RO_TYPE = cfg.readonlyAgentType || 'Plan'   // 読み取り専用かつ深く読む
const ro = (opts) => (cfg.allowWrite === true ? opts : Object.assign({}, opts, { agentType: RO_TYPE }))
log(cfg.allowWrite === true
  ? '⚠ allowWrite=true: 全エージェントが書き込み可能です'
  : '調査フェーズは読み取り専用エージェント（' + RO_TYPE + '）で実行します')

// --------------------------------------------------------------- スキーマ
const EVIDENCE = {
  type: 'array', items: { type: 'string' },
  description: '実際に開いたファイルの file:line。開いていないファイルを引用しないこと。',
}

const SURVEY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    facts: {
      type: 'array',
      description: 'このレンズで確認できた事実。推測や提案は書かない。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence: EVIDENCE,
          affects_features: {
            type: 'array', items: { type: 'string' },
            description: 'backlog.md の機能キー。無関係なら空配列。',
          },
        },
        required: ['claim', 'evidence', 'affects_features'],
      },
    },
    touch_points: {
      type: 'array',
      description: '予定されている機能のいずれかが触ることになるファイル。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string' },
          role: { type: 'string', description: 'そのファイルが担っている責務' },
          affects_features: { type: 'array', items: { type: 'string' } },
          fragility: {
            type: 'string', enum: ['low', 'medium', 'high'],
            description: 'high = 壊れやすい（文字列一致の契約、暗黙の順序依存、巨大ファイル、排他制御なし）',
          },
        },
        required: ['path', 'role', 'affects_features', 'fragility'],
      },
    },
    conventions: {
      type: 'array', items: { type: 'string' },
      description: '新しいコードが従うべき実際の作法。「〜すべき」ではなく「既存が〜している」形で書く。',
    },
    landmines: {
      type: 'array',
      description: '知らずに踏むと壊れるもの。PROJECT RULES に無い新発見のみ。',
      items: {
        type: 'object', additionalProperties: false,
        properties: { what: { type: 'string' }, evidence: EVIDENCE },
        required: ['what', 'evidence'],
      },
    },
    unknowns: {
      type: 'array', items: { type: 'string' },
      description: 'コードからは判断できず、人に聞くか実環境を見ないと分からないこと。無いものは「無い」と明記する。',
    },
  },
  required: ['facts', 'touch_points', 'conventions', 'landmines', 'unknowns'],
}

const ORDER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    shared_components: {
      type: 'array',
      description: '複数機能が同じファイル・同じ仕組みを触る箇所。ここが衝突と手戻りの発生源。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          component: { type: 'string' },
          path: { type: 'string' },
          features: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', description: '別々に実装した場合に起きること' },
        },
        required: ['component', 'path', 'features', 'risk'],
      },
    },
    dependencies: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          feature: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
          hard: { type: 'boolean', description: 'true = 順序が逆だと作り直しになる / false = 非効率なだけ' },
        },
        required: ['feature', 'depends_on', 'why', 'hard'],
      },
    },
    recommended_order: {
      type: 'array',
      description: '推奨する着手順。backlog.md に記載のスケジュールと食い違う場合は理由を書く。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          step: { type: 'number' },
          features: { type: 'array', items: { type: 'string' }, description: 'まとめて設計すべき機能群' },
          rationale: { type: 'string' },
          differs_from_backlog: { type: 'boolean' },
        },
        required: ['step', 'features', 'rationale', 'differs_from_backlog'],
      },
    },
    blocking_questions: {
      type: 'array',
      description: '着手前に人間が答えないと、どの機能も正しく設計できない問い。最重要のものから並べる。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          question: { type: 'string' },
          blocks: { type: 'array', items: { type: 'string' }, description: '答えが無いと止まる機能キー' },
          why_it_matters: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'blocks', 'why_it_matters', 'options'],
      },
    },
  },
  required: ['shared_components', 'dependencies', 'recommended_order', 'blocking_questions'],
}

// ----------------------------------------------------------------- レンズ
// ディレクトリではなく「関心」で切っている。ディレクトリで割ると、
// 設定・テレメトリ・マイグレーションのような横断的な仕組みが誰の担当でもなくなる。
//
// ▼ プロジェクト固有の関心軸は args.extraLenses で足す。
//   例: RAG なら 'rag-core'、決済なら 'billing'、モバイルなら 'native-bridge'。
const LENSES = [
  {
    key: 'precedent',
    ask: [
      'backlog.md の機能それぞれについて、このリポジトリに「最も近いことを既にやっている実装」を1つ特定し、',
      'その機能が端から端まで（画面 → API クライアント → ルート → ロジック → 永続化 → 型定義）',
      '触っているファイルを1つ残らず列挙する。',
      '',
      'この既存実装リストが、後続の全計画で「真似すべき型」になる。',
      '**このレンズが調査全体で最も価値が高い。** 時間をここに使うこと。',
    ].join('\n'),
  },
  {
    key: 'state',
    ask: [
      '状態がどこに住んでいるかを網羅する。',
      '- 永続データ（DB / ファイル / オブジェクトストレージ / 外部サービス）のスキーマと、それを読み書きする層',
      '- 設定（環境変数 / 設定ファイル / フィーチャーフラグ / ビルド時定数）',
      '- キャッシュ・セッション・一時データ',
      '新しい状態を足すとき、どこが自然な置き場かを判断できる材料を揃える。',
      'スキーマレスな保存先（JSON / NoSQL）がある場合、既存データにキーが無い場合の扱いを',
      '既存コードがどうしているか（あるいはしていないか）を必ず確認すること。',
    ].join('\n'),
  },
  {
    key: 'wiring',
    ask: [
      '「新しい単位」をアプリに認識させるための登録経路を、層ごとに全部たどる。',
      '- 新しい API / ルート / コマンドを足すとき、どこに何行追加が要るか',
      '- 新しい画面・タブ・ルートを足すとき',
      '- DI コンテナ / レジストリ / プラグイン表 / 状態管理ストアへの登録',
      '- 開発時のプロキシ設定やビルド設定への追加',
      '**「足したのに動かない」の原因になる登録漏れポイントを列挙すること。**',
    ].join('\n'),
  },
  {
    key: 'contracts',
    ask: [
      '層をまたぐ「契約」を洗い出す。契約とは、片方だけ変えても型エラーが出ずに壊れるもの。',
      '- 文字列で一致させているもの（イベント名、キー名、ルート名、ジョブ名、環境変数名）',
      '- クライアント / サーバ間の型（片方にしか型定義が無いもの）',
      '- スキーマレスな保存先のキー',
      '- 外部サービスとのインターフェース',
      '- 生成コード・スナップショットとその生成元',
      '契約ごとに「変えるなら同時に直す必要がある全箇所」を file:line で示すこと。',
    ].join('\n'),
  },
  {
    key: 'crosscut',
    ask: [
      '新機能が従うべき横断的な作法を集める。',
      '- エラー処理（例外の型、共通ハンドラ、クライアントへの返し方、ユーザーへの見せ方）',
      '- 認証と認可（誰がどこで検証しているか。**していない場合はそれを明記する**）',
      '- ログとテレメトリ（何がどこへ出るか、個人情報の扱い）',
      '- バリデーション（サーバ側 / クライアント側それぞれの作法）',
      '- 非同期処理・バックグラウンドジョブ・通知',
      '- 国際化、日時とタイムゾーンの扱い',
    ].join('\n'),
  },
  {
    key: 'ui',
    ask: [
      '画面の構造を、新しい画面・一覧・フォーム・表示要素を足す観点で解剖する。',
      '（UI を持たないプロジェクトでは args.lenses からこのレンズを外すこと）',
      '- 画面の親子関係と、状態がどこで保持されどう流れるか',
      '- 一覧・フォーム・モーダル・テーブルの既存実装と、その作り方の型',
      '- UI ライブラリが複数混在していないか。新規はどちらに寄せるべきか',
      '- 特に大きいファイル（数百行以上）は、責務ごとに区切った地図を作ること',
    ].join('\n'),
  },
  {
    key: 'verify-deploy',
    ask: [
      'この変更をどう検証し、どう本番に届けるかの現実を確定させる。',
      '- テストフレームワーク・テストコード・CI が**実在するか**。無ければ「無い」と明記する',
      '- 存在する場合: 配置と命名の規約、フィクスチャ、実行方法、対象領域の既存カバレッジ',
      '- ローカルで何がどこまで動くか。外部サービスに繋がずに動かせる範囲はどこまでか',
      '- ビルドと配備の手順。手作業が挟まる箇所',
      '- **「既存のテストに倣う」が選べない場合、各機能をどう検証しうるかの選択肢を洗い出すこと**',
    ].join('\n'),
  },
]

const EXTRA = Array.isArray(cfg.extraLenses)
  ? cfg.extraLenses.slice(0, MAX_EXTRA).map((l, i) => (typeof l === 'string' ? { key: 'extra-' + (i + 1), ask: l } : l))
  : []

const SELECTED = ONLY ? LENSES.filter(l => ONLY.indexOf(l.key) >= 0) : LENSES
if (ONLY) {
  const missing = ONLY.filter(k => LENSES.every(l => l.key !== k))
  if (missing.length) log('⚠ 該当しないレンズ名: ' + missing.join(', '))
  log('部分調査モード: ' + SELECTED.map(l => l.key).join(', ') + ' のみ実行します')
}
const ALL = SELECTED.concat(EXTRA)
if (EXTRA.length) log('追加レンズ ' + EXTRA.length + '本: ' + EXTRA.map(l => l.key).join(', '))

const preamble = [
  'あなたはこのリポジトリを並列調査する ' + ALL.length + ' 人の調査員の1人です。',
  '',
  'この調査の目的は、これから追加する機能の実装計画を立てるための土台を作ることです。',
  '',
  '最初に必ず次の2つを読んでから調査を始めてください。',
  '  1. ' + RULES + '   — 既に確定している前提と地雷。ここに書いてあることは再調査不要。',
  '  2. ' + BACKLOG + ' — 予定している機能の一覧と仕様。自分のレンズがどの機能に効くかを把握する。',
  '',
  '守ること:',
  '- 実際にコードを開くこと。すべての主張に、自分が開いたファイルの file:line を付けること。',
  '- 自分のレンズに集中すること。他のレンズは別の調査員が担当しているので、重複して掘らないこと。',
  '- 「あるべき姿」ではなく「今どうなっているか」を報告すること。提案や計画は後段の仕事です。',
  '- 無いものは「無い」と unknowns に明記すること。黙って省略しないこと。',
  '- PROJECT RULES に書かれた事実が現在のコードと食い違っていたら、それ自体を landmines に報告すること。',
].join('\n')

// -------------------------------------------------------------------- 実行
phase('Survey')

// バリア（parallel）が正当な箇所: baseline は全レンズを同時に見て統合する必要がある。
const surveys = (await parallel(ALL.map(l => () =>
  agent(preamble + '\n\n--- あなたのレンズ: ' + l.key + ' ---\n' + l.ask,
    ro({ label: 'survey:' + l.key, phase: 'Survey', schema: SURVEY_SCHEMA }))
    .then(r => (r ? Object.assign({ lens: l.key }, r) : null))
))).filter(Boolean)

log('調査完了: ' + surveys.length + '/' + ALL.length + ' レンズが結果を返した')
const surveyText = JSON.stringify(surveys, null, 1)

phase('Baseline')
const baseline = await agent([
  '並列調査の結果を統合し、追加開発の共通土台となるドキュメントを作成してください。',
  '',
  '調査結果（各レンズが file:line つきで報告したもの）:',
  surveyText,
  '',
  'やること:',
  '1. ' + RULES + ' と ' + BACKLOG + ' を読む。',
  ONLY
    ? ('2. **これは部分更新です。** ' + OUT_DIR + '/repo-baseline.md を Read で読み、\n' +
       '   今回調査したレンズ（' + SELECTED.map(l => l.key).join(', ') + '）に対応する記述だけを差し替えて、\n' +
       '   全文を Write で書き戻す。**他のレンズ由来の記述は一字一句そのまま残すこと。**\n' +
       '   既存ファイルが無い場合のみ、下の構成で新規作成する。')
    : ('2. 調査結果を統合し、次の構成で ' + OUT_DIR + '/repo-baseline.md を Write ツールで書き出す。'),
  '   - このドキュメントの使い方（機能別計画を立てる人が最初に読む前提資料であること）',
  '   - システムの地図（層ごとに、どのファイルが何を担っているか。file:line 付き）',
  '   - 機能それぞれの「当たり先」一覧（precedent レンズの成果を中心に、機能キーごとに触るファイル）',
  '   - 新しいものを足すときの作法（API / 画面 / 永続データ / 設定 それぞれの登録手順）',
  '   - 壊れやすい箇所（fragility: high の touch_points を根拠つきで）',
  '   - 新発見の地雷（PROJECT RULES に無かったもの）',
  '   - コードからは分からないこと（unknowns。誰に何を聞けばよいかまで書く）',
  '3. レンズ間で主張が食い違っている箇所があれば、自分でファイルを開いて決着をつけ、決着した内容を書く。',
  '4. **地図の基準点を記録する。** Bash で `git rev-parse HEAD` を実行し、得られた SHA を',
  '   ' + OUT_DIR + '/.baseline-commit に Write で書き出す（SHA 1行だけ、他に何も書かない）。',
  '   セッション開始時のフックがこれを使って「地図が古くなったレンズ」を検出する。',
  '',
  '書き方:',
  '- 読み手はこのリポジトリを触り始めたエンジニア。',
  '- すべての主張に file:line を残す。根拠の無い記述は書かない。',
  '- 「〜すべき」は書かない。このドキュメントは事実の地図であって計画ではない。',
].join('\n'), { label: 'write-baseline', phase: 'Baseline' })

phase('Checklist')
// 実装のたびに「既存が壊れていないか」を一通り確認するための手順書。
// 自動テストが不足している間は、これが主要な回帰確認手段になる。
// 部分調査では作り直さない（画面の全体像は一部レンズだけでは書けないため）。
const checklist = ONLY ? null : await agent([
  '現行システムの主要フローが動くことを一通り確認するための、手動QAチェックリストを作ってください。',
  '',
  '調査結果: ' + surveyText,
  '',
  'やること:',
  '1. 画面とエンドポイントの両方から、現在ユーザーと管理者ができることを網羅的に洗い出す。',
  '   ルート定義、画面のタブ構成、API のルート定義を実際に開いて確認すること。憶測で書かない。',
  '2. フローごとに「どこをどう操作して、何が起きれば正常か」を書く。',
  '   「動作確認する」のような曖昧な記述は禁止。操作と期待結果を具体的に書く。',
  '3. **目に見えにくいが壊れやすいもの**を必ず項目に含める。例:',
  '   - ストリーミング表示・リアルタイム通信（一気にではなく逐次届くこと）',
  '   - バックグラウンドジョブの進捗通知',
  '   - ファイルのダウンロード・エンコーディング・文字化け',
  '   - 設定変更が別の画面に反映されること',
  '   - 権限による表示・非表示の切り替わり',
  '4. 各項目に、壊れたときに見るべきファイルを file:line で添える。',
  '5. ' + OUT_DIR + '/regression-checklist.md に Write で書き出す。',
  '',
  '書き方:',
  '- チェックボックス形式（`- [ ] …`）。上から順に実施できる並びにする。',
  '- 所要時間の目安を冒頭に書く。全部で何分かかるかが分かること。',
  '- 外部サービスへの接続が要る項目には印を付ける（ローカルだけで確認できるものと区別する）。',
  '- 冒頭に「機能を1つ実装するたびに、このリストを一通り実行すること」と明記する。',
  '- 末尾に「新機能を追加したら、その機能のフローをこのリストに追記すること」と明記する。',
].join('\n'), { label: 'regression-checklist', phase: 'Checklist' })

phase('Order')
// 部分調査では依存関係の再計算をしない。機能間の依存は仕様由来であって、
// コードを少し変えたくらいでは変わらないため。
const order = ONLY ? null : await agent([
  '予定されている機能の相互依存を分析し、着手順を設計してください。',
  '',
  '調査結果: ' + surveyText,
  '',
  'ベースライン作成の結果: ' + String(baseline).slice(0, 4000),
  '',
  'やること:',
  DONE.length
    ? ('0. **実装済みの機能: ' + DONE.join(', ') + '**。これらは着手順から除外し、\n' +
       '   「すでに存在する実装」として shared_components と dependencies の分析に含めること。')
    : '0. すべての機能が未着手である前提で分析する。',
  '1. ' + BACKLOG + ' を読み、機能の仕様・見積もり・想定スケジュールを把握する。',
  '2. 複数機能が同じファイル・同じ仕組みを触る箇所（shared_components）を特定する。',
  '   特に注意して探すもの: 層をまたぐ契約、共通の設定ストア、巨大なファイル、',
  '   複数機能に登場する新しい概念や語彙。',
  '3. 順序が逆だと作り直しになる依存（hard: true）と、非効率なだけの依存（hard: false）を区別する。',
  '4. 推奨着手順を作る。backlog.md のスケジュールと食い違うなら理由を書く。',
  '5. 着手前に人間が答えないと設計できない問いを blocking_questions に列挙する。',
  '   影響する機能の数が多いものから並べること。',
  '6. 分析結果を ' + OUT_DIR + '/feature-order.md に Write ツールで書き出す。',
  '',
  '判断の根拠には必ず file:line を添えること。',
].join('\n'), { label: 'feature-order', phase: 'Order', schema: ORDER_SCHEMA })

if (ONLY) log('部分調査のため regression-checklist.md と feature-order.md は更新していません')

return {
  mode: ONLY ? 'partial' : 'full',
  baseline_path: OUT_DIR + '/repo-baseline.md',
  checklist_path: ONLY ? '(未更新)' : OUT_DIR + '/regression-checklist.md',
  order_path: ONLY ? '(未更新)' : OUT_DIR + '/feature-order.md',
  order: order,
  lenses_run: surveys.map(s => s.lens),
  landmines_found: surveys.reduce((n, s) => n + (s.landmines || []).length, 0),
  unknowns: surveys.reduce((a, s) => a.concat(s.unknowns || []), []),
  agents_used: ALL.length + (ONLY ? 1 : 3),
}
