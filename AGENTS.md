# AGENTS.md

このリポジトリは、株クラ投稿を収集し、AI で分析して LINE に配信する TypeScript ボットです。

## 作業方針
- 変更前に `README.md`、`package.json`、`src/` の関連ファイルを確認する。
- アプリコードを変更したら、最低でも `npm run build` を実行して確認する。
- `npm run lint` は現状 `eslint` 未導入のため、そのままでは通らない。必要なら先に整備方針を決める。
- 秘密情報は `.env` ではなく `.env.example` を基準に扱い、値を出力しない。
- `logs/` と `tmp/` は実行生成物として扱い、不要な差分を作らない。
