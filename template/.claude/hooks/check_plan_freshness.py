#!/usr/bin/env python3
"""SessionStart フック: project-rules.md への追記を促す。

「project-rules.md を最後に更新した時点」より後にソースコードが変わっていたら、
実装で分かった事実がまだ書き留められていない可能性があるので知らせる。

変更の度合いに応じて3段階で伝える:
  軽微   … 追記だけ促す
  中程度 … 追記 + 部分調査の案内
  大規模 … 追記 + 地図の全体再作成を推奨（ディレクトリの新設・移動・削除を検出したとき）

判定はコミット SHA 基準なので、新しいセッションでも新しいブランチでも動く。
何も無ければ静かに終わる。フックの失敗でセッションを止めないよう、常に終了コード 0。
"""
import json
import subprocess
import sys
from pathlib import Path

RULES = Path(".claude/workflows/project-rules.md")

# ============================================================================
# ▼ ここをプロジェクトに合わせて書き換える
# ============================================================================

# 監視するソースディレクトリ
SRC_DIRS = ["src", "app", "lib"]

# ビルド成果物・ロックファイルなど、変わっても「記録すべき事実」ではないもの
IGNORE = ("dist/", "build/", "node_modules/", "package-lock.json", "poetry.lock", "yarn.lock")

# 変更されたパス → 地図が古くなるレンズ。
# レンズ名は plan-survey.js の LENSES のキーと一致させること。
# 既定のレンズ: precedent / state / wiring / contracts / crosscut / ui / verify-deploy
LENS_MAP = [
    # ("src/api/",        ["wiring", "contracts"]),
    # ("src/models/",     ["state"]),
    # ("src/components/", ["ui"]),
    # ("src/services/",   ["crosscut"]),
    # ("infra/",          ["verify-deploy"]),
]

# 片側だけ変えると壊れる契約の組。両方が動いたときに特別な警告を出す。
# 例: SSE のイベント名（送出側 / 受信側）、API の型定義（サーバ / クライアント）
CONTRACT_PAIRS = [
    # {"name": "SSE のイベント名", "a": "src/backend/events/", "b": ("src/frontend/api/stream.ts",)},
]

# ============================================================================
# ▲ ここまで
# ============================================================================


def git(*a):
    try:
        r = subprocess.run(["git"] + list(a), capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def tracked(p):
    return git("ls-files", "--error-unmatch", str(p)) != ""


def structural_changes(base):
    """パスの形が変わった痕跡を集める。中身の変更とは区別する。

    ディレクトリ再編・ファイル移動・削除は precedent レンズの成果
    （機能 → 既存実装のパス対応表）を丸ごと無効にするため、
    部分調査ではなく全体再調査が要る合図になる。
    """
    renamed, added, deleted, newdirs = [], [], [], set()

    def note_add(path):
        added.append(path)
        d = str(Path(path).parent)
        if base and not git("ls-tree", base, "--name-only", d + "/"):
            if any(d.startswith(x) for x in SRC_DIRS):
                newdirs.add(d)

    if base:
        for ln in git("diff", "--name-status", "-M", base, "HEAD", "--", *SRC_DIRS).splitlines():
            parts = ln.split("\t")
            if not parts:
                continue
            st = parts[0]
            if st.startswith("R") and len(parts) >= 3:
                renamed.append((parts[1], parts[2]))
            elif st == "A" and len(parts) >= 2:
                note_add(parts[1])
            elif st == "D" and len(parts) >= 2:
                deleted.append(parts[1])

    for ln in git("status", "--porcelain").splitlines():
        st, p2 = ln[:2].strip(), ln[3:].strip()
        if not any(p2.startswith(d) or " -> " in p2 for d in SRC_DIRS):
            continue
        if "R" in st and " -> " in p2:
            a, b = p2.split(" -> ")
            renamed.append((a, b))
        elif st in ("A", "??"):
            note_add(p2)
        elif st == "D":
            deleted.append(p2)

    keep = lambda p: not any(p.startswith(i) for i in IGNORE)
    return ([r for r in renamed if keep(r[1])],
            [a for a in added if keep(a)],
            [d for d in deleted if keep(d)],
            sorted(newdirs))


def newer_source_files():
    """project-rules.md より後に変更されたソースを返す。"""
    changed = set()

    for ln in git("status", "--porcelain").splitlines():
        p = ln[3:].strip()
        if " -> " in p:
            p = p.split(" -> ")[-1]
        if p and any(p.startswith(d) for d in SRC_DIRS):
            changed.add(p)

    if tracked(RULES):
        base = git("log", "-1", "--format=%H", "--", str(RULES))
        if base:
            for ln in git("diff", "--name-only", base, "HEAD", "--", *SRC_DIRS).splitlines():
                if ln.strip():
                    changed.add(ln.strip())
    else:
        # 未追跡ならファイルの更新時刻で比較する
        try:
            rules_mtime = RULES.stat().st_mtime
            for d in SRC_DIRS:
                for f in Path(d).rglob("*"):
                    if f.is_file() and f.stat().st_mtime > rules_mtime:
                        changed.add(str(f))
        except Exception:
            pass

    return {p for p in changed if not any(p.startswith(i) for i in IGNORE)}


def main():
    try:
        json.load(sys.stdin)
    except Exception:
        pass

    if not RULES.exists():
        return 0   # 計画ワークフローを使っていないリポジトリでは黙る

    files = sorted(newer_source_files())
    if not files:
        return 0

    out = []
    out.append("【project-rules.md への追記】")
    out.append(f"project-rules.md を最後に更新した時点より後に、ソースが {len(files)} 件変わっています。")
    out.append("")
    for f in files[:8]:
        out.append(f"  {f}")
    if len(files) > 8:
        out.append(f"  … 他 {len(files) - 8} 件")
    out.append("")

    for pair in CONTRACT_PAIRS:
        hit_a = any(p.startswith(pair["a"]) for p in files)
        hit_b = any(p in pair["b"] for p in files)
        if hit_a and hit_b:
            out.append(f"  ⚠ 「{pair['name']}」の両側が変わっています。")
            out.append("    project-rules.md の『契約と壊れやすい箇所』の更新が要るかもしれません。")
            out.append("")

    out.append("実装で分かった事実があれば .claude/workflows/project-rules.md に追記するよう、")
    out.append("ユーザーに促してください（書くのはユーザー本人。勝手に書き足さないこと）。")
    out.append("促すときは文面の案を提示すること。")
    out.append("作業がまだ途中の場合は、この通知を無視して構いません。")

    base = git("log", "-1", "--format=%H", "--", str(RULES)) if tracked(RULES) else ""
    renamed, added, deleted, newdirs = structural_changes(base)
    lenses = sorted({l for f in files for pre, ls in LENS_MAP if f.startswith(pre) for l in ls})

    structural = bool(renamed or deleted or newdirs)
    big = structural or len(lenses) >= 5 or len(files) >= 30

    out.append("")
    if big:
        out.append("─" * 60)
        out.append("【重要】構造が変わった可能性があります。地図の全体再作成を検討してください。")
        out.append("")
        if newdirs:
            out.append(f"  新設ディレクトリ: {', '.join(newdirs[:5])}")
        if renamed:
            ex = ", ".join(f"{a} → {b}" for a, b in renamed[:3])
            out.append(f"  移動/リネーム {len(renamed)} 件: {ex}")
        if deleted:
            out.append(f"  削除 {len(deleted)} 件: {', '.join(deleted[:3])}")
        if not structural:
            out.append(f"  影響レンズ {len(lenses)} 個 / 変更 {len(files)} ファイル（規模が大きい）")
        out.append("")
        out.append("  ディレクトリの移動や層の追加があると、repo-baseline.md の precedent")
        out.append("  （機能 → 真似すべき既存実装のパス対応表）が丸ごとずれます。")
        out.append("  precedent は全機能に効くため、以降の全計画の精度が落ちます。")
        out.append("")
        out.append("  → ユーザーに確認のうえ /plan-survey を全体実行。")
        out.append("     実装済みの機能があれば done: ['...'] を渡すと着手順から除外されます。")
        out.append("─" * 60)
    elif len(lenses) >= 2:
        out.append(f"（地図も更新するなら /plan-survey lenses: {lenses}。必須ではありません）")
    elif lenses:
        out.append(f"（変更は {lenses[0]} 層のみ。project-rules への追記で足りるはずです）")
    elif not LENS_MAP:
        out.append("（LENS_MAP が未設定です。このフックの上部を編集すると、")
        out.append("  変更されたパスから『どのレンズの地図が古くなったか』も知らせられます）")

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
