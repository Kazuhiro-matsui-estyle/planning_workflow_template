# 計画ワークフローの使い方

使い方の本文は、このテンプレートの配布元リポジトリの README.md にあります。

https://github.com/Kazuhiro-matsui-estyle/planning_workflow_template#readme

このフォルダのファイルの役割:

| ファイル | 役割 |
|---|---|
| `project-rules.md` | 確定した前提と地雷（人が書く。全エージェントが最初に読む） |
| `backlog.md` | 機能の一覧と仕様・機能キー（人が書く） |
| `fix-procedure.md` | 指摘・症状を直す手順（CLAUDE.md が「直す前に必ず開く」と指示する） |
| `verification.md` | 検証の手順（CLAUDE.md「### 6.」(1)〜(5) の本体） |
| `plan-survey.js` / `plan-feature.js` | 計画ワークフロー本体（普段触らない） |
