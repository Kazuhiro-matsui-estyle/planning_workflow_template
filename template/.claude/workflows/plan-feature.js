export const meta = {
  name: 'plan-feature',
  description: '機能を1つ計画する: 深掘り調査 → 設計案 → 影響範囲の反証 → 抜け漏れ補充 → 実装計画',
  whenToUse: 'plan-survey を1回実行した後、機能1つに着手する直前に、機能キーを指定して実行する',
  phases: [
    { title: 'Probe',  detail: '機能特化の深掘り4本（前例・影響層・契約・制約）。refine 時はスキップ' },
    { title: 'Draft',  detail: '設計案・変更計画・影響範囲・決めるべきこと' },
    { title: 'Refute', detail: '影響範囲の主張を1つずつ反証しにいく' },
    { title: 'Gaps',   detail: '完全性批評 + 指摘された穴の再調査' },
    { title: 'Plan',   detail: '最終計画を docs/plan/<key>.md に書き出す' },
  ],
}

// ---------------------------------------------------------------- 参照資料
const RULES     = '.claude/workflows/project-rules.md'
const BACKLOG   = '.claude/workflows/backlog.md'
const OUT_DIR   = 'docs/plan'
const ORDER_DOC = 'docs/plan/feature-order.md'
const BASELINE_DEFAULT = 'docs/plan/repo-baseline.md'

// ------------------------------------------------------------------ 入力
const cfg = (args && typeof args === 'object' && !Array.isArray(args)) ? args : { feature: String(args || '') }
const num = (v, d) => (typeof v === 'number' ? v : d)

const KEY      = cfg.feature || ''
const NOTE     = cfg.note || ''          // 決まった仕様・open_decisions への回答を渡す
const BASELINE = cfg.baseline || BASELINE_DEFAULT
const MAX_REFUTE = num(cfg.maxRefute, 3)
const MAX_REFILL = num(cfg.maxRefill, 2)
const MAX_EXTRA  = num(cfg.maxExtraProbes, 2)

if (!KEY) {
  log('feature キーが未指定です。' + BACKLOG + ' の「機能キー」表から選んで args.feature に渡してください。')
}
log('計画対象: ' + (KEY || '(未指定)') + ' / ベースライン: ' + BASELINE)

// refine: true を渡すと深掘り調査をスキップし、既存の計画書 + 新しい note を土台に作り直す。
// 「open_decisions に答えたので計画を更新したい」場合に使う。12 → 8 エージェントに減る。
const REFINE = cfg.refine === true
const PLAN_PATH = OUT_DIR + '/' + (KEY || 'feature') + '.md'

// ------------------------------------------------------- 書き込みの安全装置
const RO_TYPE = cfg.readonlyAgentType || 'Plan'
const ro = (opts) => (cfg.allowWrite === true ? opts : Object.assign({}, opts, { agentType: RO_TYPE }))
log(cfg.allowWrite === true
  ? '⚠ allowWrite=true: 全エージェントが書き込み可能です'
  : '最終計画フェーズ以外は読み取り専用エージェント（' + RO_TYPE + '）で実行します')

// --------------------------------------------------------------- スキーマ
const EVIDENCE = {
  type: 'array', items: { type: 'string' },
  description: '実際に開いたファイルの file:line。開いていないファイルを引用しないこと。',
}

const PROBE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence: EVIDENCE,
          implication: { type: 'string', description: 'この機能を実装するうえで何を意味するか' },
        },
        required: ['claim', 'evidence', 'implication'],
      },
    },
    files_in_play: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
          change_kind: { type: 'string', enum: ['new', 'edit', 'read-only'] },
        },
        required: ['path', 'why', 'change_kind'],
      },
    },
    blockers: {
      type: 'array', items: { type: 'string' },
      description: 'このままでは実装できない事柄（不足している情報・仕組み・合意）',
    },
  },
  required: ['findings', 'files_in_play', 'blockers'],
}

// このリポジトリ固有の「出荷事故パターン」は project-rules.md の
// 「出荷の制約」節に列挙されている。それを1項目ずつ潰させる。
const DEPLOY_IMPACT = {
  type: 'object', additionalProperties: false,
  description: 'project-rules.md の「出荷の制約」節の各項目について、該当するかを1つずつ判定する。',
  properties: {
    hazards: {
      type: 'array',
      description: 'project-rules.md に列挙されている制約を全部並べ、該当しないものも applies:false で必ず載せること。'
                 + '見落としと「確認したうえで該当なし」を区別するため。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          hazard: { type: 'string', description: 'project-rules.md に書かれている制約（引用）' },
          applies: { type: 'boolean' },
          action: { type: 'string', description: 'applies:true のとき、具体的に何をするか。false なら「該当なし」' },
        },
        required: ['hazard', 'applies', 'action'],
      },
    },
    deps_added: {
      type: 'array', items: { type: 'string' },
      description: '追加する依存パッケージ（言語を問わず）。ライセンスと保守状況も確認すること。',
    },
    config_added: {
      type: 'array', items: { type: 'string' },
      description: '追加する環境変数・設定項目。実環境への反映手段が手作業かどうかも書く。',
    },
    data_migration: {
      type: 'string',
      description: '既存データの変換・再処理が要るか。要るならその規模と所要時間。不要なら「不要」。',
    },
    contract_changes: {
      type: 'array', items: { type: 'string' },
      description: '層をまたぐ契約の変更（イベント名・型・スキーマ・キー名）。同時に直す全箇所を挙げる。',
    },
    notes: { type: 'string', description: '上の該当項目それぞれの具体的な手順と注意' },
  },
  required: ['hazards', 'deps_added', 'config_added', 'data_migration', 'contract_changes', 'notes'],
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    summary: { type: 'string', description: '何を作るのかを3文以内で' },

    approach_options: {
      type: 'array',
      description: '設計の分岐。1案しか成立しないなら1件でよいが、その場合は他案が成立しない理由を cons に書く。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          rough_effort: { type: 'string', description: 'backlog.md の見積もり単位に換算した粗い規模感' },
          recommended: { type: 'boolean' },
        },
        required: ['name', 'summary', 'pros', 'cons', 'rough_effort', 'recommended'],
      },
    },

    open_decisions: {
      type: 'array',
      description: '人間（PM / 顧客）が決めないと実装できないこと。実装者が勝手に決めてはいけない事柄。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
          blocks: { type: 'string', description: '決まらないと何が着手できないか' },
          decide_by: { type: 'string', enum: ['before-start', 'before-review', 'can-defer'] },
        },
        required: ['question', 'options', 'recommendation', 'blocks', 'decide_by'],
      },
    },

    changes: {
      type: 'array',
      description: '推奨案に沿った変更。1行1ファイル。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['new', 'edit', 'delete'] },
          what: { type: 'string' },
          follows_convention: { type: 'string', description: '真似する既存実装と、その file:line' },
          evidence: EVIDENCE,
        },
        required: ['path', 'kind', 'what', 'follows_convention', 'evidence'],
      },
    },

    blast_radius: {
      type: 'array',
      description: '「Xを変えると影響するのはA,B,Cだけ」という形の、反証可能な主張。曖昧な主張は無価値。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          affected: { type: 'array', items: { type: 'string' } },
          evidence: EVIDENCE,
        },
        required: ['claim', 'affected', 'evidence'],
      },
    },

    verification: {
      type: 'array',
      description: 'project-rules.md の「テストの現実」節を読み、実際に使える手段だけで設計すること。'
                 + 'テスト基盤が無いなら「既存テストに倣う」は選べない。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          level: { type: 'string', enum: ['unit', 'integration', 'e2e', 'manual-qa', 'throwaway-script', 'new-test-infra'] },
          what: { type: 'string', description: '何を確かめるか' },
          how: { type: 'string', description: '具体的な操作列またはコマンド。「動作確認する」のような曖昧な記述は禁止' },
          covers: { type: 'string', description: 'どの変更または blast_radius 項目を担保するか' },
          needs_external: { type: 'boolean', description: '外部サービスへの接続が必要か（ローカルだけで完結しないか）' },
        },
        required: ['level', 'what', 'how', 'covers', 'needs_external'],
      },
    },

    deploy_impact: DEPLOY_IMPACT,

    security_notes: {
      type: 'array', items: { type: 'string' },
      description: '新しい入口（API・画面・ジョブ）を足す場合、project-rules.md に記録された既知の'
                 + 'セキュリティ上の欠陥を繰り返していないかの確認結果。該当しない場合も「該当なし」と明記する。',
    },

    estimate_check: {
      type: 'object', additionalProperties: false,
      description: 'backlog.md の見積もりに収まるかの判定。見積もりを提示済みなら、超過は早期に分かる必要がある。',
      properties: {
        planned: { type: 'string', description: 'backlog.md に書かれた見積もり' },
        assessed: { type: 'string', description: '調査を踏まえた見積もり' },
        verdict: { type: 'string', enum: ['fits', 'tight', 'exceeds'] },
        why: { type: 'string' },
        what_would_make_it_fit: { type: 'string', description: 'exceeds / tight の場合、削るとしたら何か' },
      },
      required: ['planned', 'assessed', 'verdict', 'why', 'what_would_make_it_fit'],
    },

    regression_additions: {
      type: 'array',
      description: 'この機能を実装したあと docs/plan/regression-checklist.md に追記すべきチェック項目。'
                 + '新しく増えるユーザー操作と、既存フローで挙動が変わる箇所の両方を出すこと。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          item: { type: 'string', description: 'チェックボックス1行分。操作と期待結果を具体的に' },
          kind: { type: 'string', enum: ['new-flow', 'changed-existing'] },
          needs_external: { type: 'boolean' },
        },
        required: ['item', 'kind', 'needs_external'],
      },
    },

    risks: { type: 'array', items: { type: 'string' } },

    sequence: {
      type: 'array',
      description: '各ステップ単体でレビュー可能かつ、その時点でアプリが壊れていない順序。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          step: { type: 'number' },
          what: { type: 'string' },
          reviewable_alone: { type: 'boolean' },
          leaves_app_working: { type: 'boolean' },
        },
        required: ['step', 'what', 'reviewable_alone', 'leaves_app_working'],
      },
    },
  },
  required: ['feature', 'summary', 'approach_options', 'open_decisions', 'changes', 'blast_radius',
             'verification', 'deploy_impact', 'security_notes', 'estimate_check',
             'regression_additions', 'risks', 'sequence'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    missed: { type: 'array', items: { type: 'string' }, description: '主張が見落としている呼び出し元・購読者・設定・画面・ドキュメント' },
    reasoning: { type: 'string' },
    evidence: EVIDENCE,
  },
  required: ['refuted', 'missed', 'reasoning', 'evidence'],
}

const GAPS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          question: { type: 'string' },
          why: { type: 'string', description: '見つからないまま進むと何が起きるか' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['question', 'why', 'severity'],
      },
    },
  },
  required: ['gaps'],
}

// ------------------------------------------------------------------ 前置き
const context = [
  'あなたはこのリポジトリに機能を1つ追加するための計画を立てるチームの一員です。',
  '',
  '## 計画対象の機能',
  '機能キー: ' + KEY,
  NOTE ? ('決まっている仕様・前回の決定事項:\n' + NOTE) : '（backlog.md に書かれている内容以外の追加情報は無い）',
  '',
  '## 最初に必ず読むもの',
  '1. ' + BACKLOG + '  — 機能の仕様。' + KEY + ' の節と、全機能に関わる横断事項を精読する。',
  '2. ' + RULES + '    — 確定済みの前提と地雷。ここに書かれた事実は再調査不要。ただし矛盾を見つけたら報告する。',
  '3. ' + BASELINE + ' — 事前調査で作られたリポジトリの地図。無ければその旨を述べて自力で調べる。',
  '4. ' + ORDER_DOC + ' — 機能間の依存と共有部品。**この機能が触るファイルを他のどの機能も触るか**を確認する。',
  '   （他機能と共有するファイルを変えるときは、その旨を risks に書き、変更を最小限にする設計を選ぶこと）',
  '',
  '## 守ること',
  '- 見積もりが提示済みの場合、設計がそれを超えるなら早期に判明する必要がある。',
  '- 検証手段は project-rules.md の「テストの現実」節に書かれた実情に沿って設計すること。',
  '- 出荷の制約（project-rules.md）を1項目ずつ潰すこと。',
  '- 既知のセキュリティ上の欠陥があるなら、新しいコードで同じ形を真似しないこと。',
].join('\n')

// ----------------------------------------------------------------- 深掘り
const PROBES = [
  {
    key: 'precedent',
    ask: [
      'この機能に最も近いことを「既にやっている」実装をリポジトリの中から特定し、',
      '端から端まで（画面 → API クライアント → ルート → ロジック → 永続化 → 通知 → 型定義 → 規約）',
      '触っているファイルを1つ残らず列挙してください。',
      '',
      '複数の候補がある場合は、最も近いもの1つを主軸にしつつ、部分的に参考になるものも挙げること。',
      '',
      'この列挙が「新しいコードが真似すべき型」になります。**このプローブの成果が計画全体の品質を決めます。**',
    ].join('\n'),
  },
  {
    key: 'impact',
    ask: [
      'この機能が実際に手を入れることになる層を、ベースラインより一段深く読んでください。',
      '対象ファイルは実際に開いて、関数単位・state 単位で構造を把握すること。',
      '',
      '特に、変更を差し込む場所の周辺で',
      '- 何が暗黙の前提になっているか（引数の形、呼ばれる順序、null や空文字の扱い）',
      '- 既存の分岐がどれだけあり、新しいケースを足すとどこに追加が要るか',
      '- そのファイルが他のどこから使われているか',
      'を確認してください。',
    ].join('\n'),
  },
  {
    key: 'contract',
    ask: [
      'この機能が変更・追加することになる「契約」を両側から確認してください。',
      '契約とは、片方だけ変えると型エラーも出ずに壊れるものです。例:',
      '- 文字列で一致させているもの（イベント名、キー名、ルート名、ジョブ名、設定キー）',
      '- クライアント / サーバ間の型（片方にしか型定義が無いもの）',
      '- スキーマレスな保存先のキー（既存データにそのキーが無い場合の挙動を含む）',
      '- 外部サービスとのインターフェース、生成コードとその生成元',
      '',
      'この機能が触る契約を特定し、変更する場合に「同時に直さなければならない全箇所」を',
      'file:line で列挙してください。該当する契約が無い場合は「無い」と明言してください。',
    ].join('\n'),
  },
  {
    key: 'constraint',
    ask: [
      'この機能に固有の制約を洗い出してください。汎用的なものではなく、この機能だからこそ効くものです。',
      '観点の例（当てはまるものだけ深く掘る）:',
      '- 新しい外部通信が必要か。ネットワーク構成上そこへ到達できるか',
      '- 定期実行・非同期処理の仕組みが必要か。現システムに存在するか',
      '- 新しいライブラリの選定が必要か。既存の依存と衝突しないか。ライセンスと保守状況は',
      '- 既存の合意や決定事項を覆すことになるか（project-rules.md の該当節を参照）',
      '- 既存データの移行や再処理が必要か。その規模・所要時間・コストは',
      '- 個人情報・機微情報の扱いが増えるか',
      '- パフォーマンスや従量課金に効くか',
      '',
      '制約ごとに、それが「実装前に解決すべきこと」なのか「実装しながら判断できること」なのかを分けてください。',
    ].join('\n'),
  },
]

const EXTRA = Array.isArray(cfg.extraProbes)
  ? cfg.extraProbes.slice(0, MAX_EXTRA).map((p, i) => (typeof p === 'string' ? { key: 'extra-' + (i + 1), ask: p } : p))
  : []
const ALL_PROBES = PROBES.concat(EXTRA)
if (EXTRA.length) log('追加プローブ ' + EXTRA.length + '本')

// -------------------------------------------------------------------- 実行
phase('Probe')

// refine モードでは深掘りを丸ごと省く。調査対象は「コードが今どうなっているか」であって
// 人間の決定に依存しないため、決定が変わっただけで再調査する必要がない。
const probes = REFINE ? [] : (await parallel(ALL_PROBES.map(p => () =>
  agent(context + '\n\n## あなたの担当: ' + p.key + '\n' + p.ask +
        '\n\n実際にコードを開くこと。すべての主張に file:line を付けること。' +
        '\n報告するのは「今どうなっているか」であって、設計案ではありません。',
    ro({ label: 'probe:' + p.key, phase: 'Probe', schema: PROBE_SCHEMA }))
    .then(r => (r ? Object.assign({ probe: p.key }, r) : null))
))).filter(Boolean)

if (REFINE) {
  log('refine モード: 深掘り調査をスキップし、既存の計画書 ' + PLAN_PATH + ' を土台にします')
} else {
  log('深掘り完了: ' + probes.length + '/' + ALL_PROBES.length + ' 本')
}
const probeText = REFINE
  ? '（refine モード。深掘り調査の代わりに、既存の計画書 ' + PLAN_PATH + ' を Read で読むこと）'
  : JSON.stringify(probes, null, 1)

phase('Draft')
const draft = await agent([
  context,
  '',
  REFINE ? '## 土台にする既存の計画書' : '## 深掘り調査の結果',
  probeText,
  '',
  '## あなたの仕事',
  REFINE
    ? [
        'これは**計画の更新**です。前回の計画に対して人間が決定を返してきました。',
        '',
        '手順:',
        '1. ' + PLAN_PATH + ' を Read で読む。前回の設計案・変更一覧・影響範囲・open_decisions を把握する。',
        '2. 上の「決まっている仕様・前回の決定事項」を、前回の open_decisions への回答として解釈する。',
        '3. 決着した項目を open_decisions から外し、**その決定を前提に設計を確定させる**。',
        '   決定によって設計案が絞られたなら approach_options を1案に収束させてよい。',
        '4. 決定の結果として新たに生じた判断事項があれば、open_decisions に追加する。',
        '5. 決定が影響範囲や検証手順を変えるなら、そこも書き直す。',
        '',
        '**前回の計画で確定していた内容（変更ファイル一覧、file:line の根拠）は引き継ぐこと。**',
        '根拠が薄いと感じた箇所だけ、自分でファイルを開いて確かめ直してください。',
      ].join('\n')
    : 'これらを統合して実装計画の草案を作ってください。',
  '',
  '守ること:',
  '- **決まっていないことを勝手に決めない。** 実装者が決めてよいこと（命名、ファイル分割）と、',
  '  人が決めるべきこと（保存先の選択、既存仕様の変更、外部依存の追加、UI の挙動）を区別し、',
  '  後者は open_decisions に出す。推奨は述べてよいが、決定はしない。',
  '- **設計に分岐があるなら approach_options に複数案を出す。** 1案に見えても、',
  '  「既存の仕組みを流用する案」と「新しく作る案」は大抵両方成立する。トレードオフを書く。',
  '- changes の各項目は、真似する既存実装を file:line つきで示す（follows_convention）。発明しない。',
  '- blast_radius は「Xを変えると影響するのはA,B,Cだけ」という反証可能な形で書く。',
  '  次の工程でこれを攻撃するので、曖昧な主張は無価値。',
  '- verification は「動作確認する」では不可。画面のどこをどう操作して何を見るか、',
  '  あるいはどのコマンドを叩いて何を確認するかまで書く。',
  '- deploy_impact.hazards は ' + RULES + ' の「出荷の制約」節を1項目ずつ引用して判定する。',
  '  該当しないものも applies:false で載せること。',
  '- estimate_check で ' + BACKLOG + ' の見積もりと照合する。超過しそうなら正直に exceeds とする。',
  '- 調査結果が食い違っていたり不明点が残っていたら、自分でファイルを開いて決着をつける。',
].join('\n'), ro({ label: 'draft-plan', phase: 'Draft', schema: PLAN_SCHEMA }))

const claims = ((draft && draft.blast_radius) || []).slice(0, MAX_REFUTE)
if (((draft && draft.blast_radius) || []).length > claims.length) {
  log('反証対象を ' + claims.length + '/' + draft.blast_radius.length + ' 件に制限した')
}

phase('Refute')
const verdicts = (await parallel(claims.map((c, i) => () =>
  agent([
    'あなたはこのリポジトリの影響範囲の主張を**反証する**担当です。計画を擁護してはいけません。',
    '',
    '対象の主張: ' + c.claim,
    '影響すると主張されている範囲: ' + ((c.affected || []).join(', ') || '(なし)'),
    '主張の根拠: ' + ((c.evidence || []).join(', ') || '(なし)'),
    '',
    'この主張が見落としているものを探してください。探す先の例:',
    '- 他の呼び出し元、他の分岐、同じ関数を使う別のフロー',
    '- 文字列キーで参照されている箇所 — **grep で識別子を実際に検索すること**',
    '- 設定ファイル、ビルド設定、インフラ定義',
    '- 既存データにそのキーが無い場合の挙動',
    '- 管理者向けと一般ユーザー向けの両方の画面',
    '- README やドキュメント、生成コード、スナップショット',
    '',
    '計画の文面から推論するのではなく、コードを開いて確かめること。',
    '**何か1つでも見落としを見つけたら refuted=true にすること。判断に迷う場合も refuted=true にすること。**',
  ].join('\n'),
    ro({ label: 'refute:' + (i + 1), phase: 'Refute', schema: VERDICT_SCHEMA }))
    .then(v => (v ? Object.assign({ claim: c.claim }, v) : null))
))).filter(Boolean)

const broken = verdicts.filter(v => v.refuted)
log('反証結果: ' + broken.length + '/' + verdicts.length + ' 件の影響範囲の主張が不完全だった')

phase('Gaps')
const critique = await agent([
  context,
  '',
  'あなたは完全性の批評家です。以下は、この機能の調査結果と計画草案です。',
  '',
  '深掘り調査: ' + probeText,
  '計画草案: ' + JSON.stringify(draft, null, 1),
  '反証結果: ' + JSON.stringify(verdicts, null, 1),
  '',
  '**「間違っているもの」ではなく「抜けているもの」**を指摘してください。観点の例:',
  '- 誰も調べていないサブシステム',
  '- 誰も開いていないファイル種別（設定、CI、インフラ定義、シェルスクリプト、型定義）',
  '- 検証手段が用意されていない変更',
  '- 異常系（失敗したとき、途中で止まったとき、同時に操作されたとき）の設計',
  '- 既存データが新しい形式を持っていない場合の扱い',
  '- ロールバック手順',
  '- 権限まわり（新しい入口に認可が付いているか）',
  '- 運用（誰がどう設定するか、設定を間違えたときにどうなるか）',
  '',
  '見つからないまま進んだ場合の被害が大きい順に並べてください。',
  '本当に何も見つからない場合のみ空の配列を返してください。',
].join('\n'), ro({ label: 'completeness-critic', phase: 'Gaps', schema: GAPS_SCHEMA }))

const allGaps = (critique && critique.gaps) || []
const gaps = allGaps.slice(0, MAX_REFILL)
if (allGaps.length > gaps.length) {
  log('穴の再調査を ' + gaps.length + '/' + allGaps.length + ' 件に制限した（残りは unaddressed_gaps に返す）')
}

const refills = gaps.length
  ? (await parallel(gaps.map((g, i) => () =>
      agent([
        context,
        '',
        '## あなたの担当: 批評家が指摘した穴の再調査',
        '問い: ' + g.question,
        'この穴が放置された場合に起きること: ' + g.why,
        '重大度: ' + g.severity,
        '',
        '上の問いに、実際のコードから答えてください。すべての主張に file:line を付けること。',
        '答えが「そのような仕組みは存在しない」である場合も、探した場所を挙げたうえでそう明言してください。',
      ].join('\n'),
        ro({ label: 'gap:' + (i + 1), phase: 'Gaps', schema: PROBE_SCHEMA }))
        .then(r => (r ? Object.assign({ gap: g.question }, r) : null))
    ))).filter(Boolean)
  : []

phase('Plan')
const final = await agent([
  context,
  '',
  '## 材料',
  '計画草案: ' + JSON.stringify(draft, null, 1),
  '',
  '不完全と判明した影響範囲の主張（missed の項目を changes / blast_radius / verification のいずれかに必ず折り込むこと）:',
  JSON.stringify(broken, null, 1),
  '',
  '穴の再調査の結果: ' + JSON.stringify(refills, null, 1),
  '',
  '## あなたの仕事',
  '最終的な実装計画を確定し、' + PLAN_PATH + ' に Write ツールで書き出してください。',
  '',
  '守ること:',
  '- **反証結果と穴の調査結果を黙って落とさない。** スコープ外と判断したものは risks にその旨を書く。',
  '- file:line の引用を残す。根拠の無い変更項目は risks で「未検証の推測」と明記する。',
  '- sequence は各ステップ単体でレビューでき、その時点でアプリが壊れていない順序にする。',
  '  層をまたぐ契約を変えるステップは、両側を1ステップにまとめる（片側だけでは壊れるため）。',
  '- open_decisions は減らさない。実装者が勝手に決めてよいものだけを除く。',
  '',
  '## 書き出す Markdown の構成',
  '  1. この機能で作るもの（3文以内）と、見積もりに対する評価',
  '  2. **先に決めてほしいこと**（open_decisions を、決定期限の早い順に。選択肢と推奨つき）',
  '  3. 設計案（複数ある場合は比較表と推奨）',
  '  4. 変更するファイル一覧（新規 / 編集の別、真似する既存実装、file:line）',
  '  5. 影響範囲（反証を通過したもの / 反証で広がったもの を区別して書く）',
  '  6. 検証手順（具体的な操作列またはコマンド）',
  '  7. 出荷時にやること（deploy_impact の該当項目のみ）',
  '  8. 回帰チェックリストへの追記項目（regression_additions）',
  '     実装後に docs/plan/regression-checklist.md へ追記する行を、そのまま貼れる形で示すこと',
  '  9. リスクと未確定事項',
  ' 10. 実装の順序（各ステップがレビュー可能で、アプリが壊れないこと）',
  '',
  '読み手はこのリポジトリを触るエンジニアと、顧客や社内と話す PM の両方です。',
].join('\n'), { label: 'final-plan', phase: 'Plan', schema: PLAN_SCHEMA })

return {
  feature: KEY,
  mode: REFINE ? 'refine' : 'full',
  plan_path: PLAN_PATH,
  plan: final,
  open_decisions: (final && final.open_decisions) || [],
  estimate_check: (final && final.estimate_check) || null,
  refuted_claims: broken,
  unaddressed_gaps: allGaps.slice(MAX_REFILL),
  blockers: probes.reduce((a, p) => a.concat(p.blockers || []), []),
  agents_used: (REFINE ? 0 : ALL_PROBES.length) + 1 + claims.length + 1 + gaps.length + 1,
}
