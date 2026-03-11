# 株クラ AI 分析 LINE Bot

X（Twitter）の株クラスタ投稿を自動収集し、OpenAI が「風が吹けば桶屋が儲かる」視点で
隠れ恩恵銘柄を発掘。毎日 朝8時・夜8時に LINE へ自動配信するボット。

```
X 投稿収集（86アカウント）
    ↓
OpenAI 分析（連想投資・テーマ抽出）
    ↓
LINE Messaging API ブロードキャスト配信
```

---

## 目次

1. [必要環境](#必要環境)
2. [セットアップ手順](#セットアップ手順)
3. [LINE 公式アカウント設定](#line-公式アカウント設定)
4. [環境変数一覧](#環境変数一覧)
5. [使い方](#使い方)
6. [投稿取得の仕組み](#投稿取得の仕組み)
7. [ディレクトリ構成](#ディレクトリ構成)
8. [トラブルシューティング](#トラブルシューティング)
9. [免責事項](#免責事項)

---

## 必要環境

| ソフトウェア | バージョン | 用途 |
|:---|:---:|:---|
| Node.js | 18 以上 | アプリ本体 |
| Docker / Docker Compose | 最新版 | RSS-Bridge コンテナ |
| LINE 公式アカウント | — | Messaging API 配信 |
| OpenAI API キー | — | OpenAI 分析 |

---

## セットアップ手順

### 1. リポジトリの準備

```bash
cd kabu-line-bot
npm install
```

### 2. RSS-Bridge を Docker で起動

X（Twitter）の投稿を RSS として取得するためのプロキシサーバーです。

```bash
docker compose up -d

# 起動確認
docker compose ps
# → rss-bridge が "Up" になっていれば OK

# ブラウザで http://localhost:3000 を開き
# 検索ボックスに「Twitter」と入力して TwitterBridge が表示されれば正常
```

### 3. OpenAI API キーの取得

1. [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys) にアクセス
2. アカウント作成 → ログイン
3. 「Create new secret key」をクリック
4. 発行されたキーをコピー（表示は一度きり）

### 4. LINE 公式アカウントの作成と API 設定

→ 詳細は次のセクション「[LINE 公式アカウント設定](#line-公式アカウント設定)」を参照

### 5. 環境変数の設定

```bash
cp .env.example .env
```

`.env` をエディタで開いて各値を入力:

```env
LINE_CHANNEL_ACCESS_TOKEN=発行したチャネルアクセストークン
LINE_CHANNEL_SECRET=チャネルシークレット
OPENAI_API_KEY=sk-...
RSS_BRIDGE_URL=http://localhost:3000
NITTER_INSTANCE=https://nitter.privacydev.net
```

### 6. 動作確認

```bash
# LINE 接続テスト
npm run send-test

# 投稿取得テスト（分析・配信なし）
npm run fetch-only

# フルパイプライン手動実行
npm run analyze
```

### 7. 本番起動

```bash
# ビルド
npm run build

# 起動（毎日 08:00 / 20:00 JST に自動実行）
npm run start
```

開発中（ファイル変更で自動再起動）:

```bash
npm run dev
```

---

## LINE 公式アカウント設定

### Step 1: LINE Official Account Manager でアカウント作成

1. [LINE for Business](https://www.linebiz.com/jp/) にアクセス
2. 「LINE 公式アカウント開設」→ アカウント作成
3. アカウント種別は「**個人**」または「**法人**」を選択
4. 作成後、[LINE Official Account Manager](https://manager.line.biz/) にログイン

### Step 2: Messaging API を有効化

1. LINE Official Account Manager でアカウントを選択
2. 左メニュー「**設定**」→「**Messaging API**」
3. 「Messaging API を利用する」をクリック
4. プロバイダー選択（新規作成 or 既存から選択）
5. 「同意する」→ Messaging API チャネルが作成される

### Step 3: LINE Developers でトークン発行

1. [LINE Developers Console](https://developers.line.biz/console/) にアクセス
2. 作成したチャネルを選択
3. 「**Messaging API 設定**」タブを開く
4. 「チャネルアクセストークン（長期）」の「**発行**」をクリック
5. 発行されたトークンを `.env` の `LINE_CHANNEL_ACCESS_TOKEN` に設定

### Step 4: チャネルシークレットの確認

1. 同じチャネルの「**チャネル基本設定**」タブ
2. 「チャネルシークレット」をコピー
3. `.env` の `LINE_CHANNEL_SECRET` に設定

### Step 5: 友だち追加

1. 「Messaging API 設定」タブの QR コードをスキャン
2. 公式アカウントを友だちに追加
3. `npm run send-test` でテストメッセージが届けば設定完了

> **Note:** ブロードキャスト配信は、アカウントを友だち追加している全員に送信されます。

---

## 環境変数一覧

`.env.example` をコピーして `.env` を作成してください。

| 変数名 | 必須 | 説明 | 例 |
|:---|:---:|:---|:---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | LINE チャネルアクセストークン | `eyJhbG...` |
| `LINE_CHANNEL_SECRET` | — | LINE チャネルシークレット | `abc123...` |
| `OPENAI_API_KEY` | ✅ | OpenAI API キー | `sk-...` |
| `RSS_BRIDGE_URL` | — | RSS-Bridge の URL | `http://localhost:3000` |
| `NITTER_INSTANCE` | — | Nitter インスタンスの URL | `https://nitter.privacydev.net` |
| `HEALTH_PORT` | — | ヘルスチェックサーバーのポート（デフォルト: 8080） | `8080` |

---

## 使い方

### 自動実行スケジュール

| 時刻 | 内容 |
|:---:|:---|
| **毎日 08:00 JST** | 朝の部：夜間〜朝の投稿を収集・分析・配信 |
| **毎日 20:00 JST** | 夜の部：日中の投稿を収集・分析・配信 |

### コマンド一覧

```bash
npm run start        # 本番起動（スケジューラー常駐）
npm run dev          # 開発用（nodemon による自動再起動）
npm run build        # TypeScript をコンパイル

npm run analyze      # 今すぐ分析＆LINE 配信（手動実行）
npm run fetch-only   # 投稿取得のみ（分析・配信なし）
npm run send-test    # LINE にテストメッセージを送信
npm run show-logs    # 直近の実行ログを表示
```

### LINE メッセージのフォーマット

```
📊 株クラ AI 分析レポート
━━━━━━━━━━━━━━━━━━━━
📅 2026/03/02 朝の部

🔥 注目テーマ
1. AIデータセンター（言及数: 12 件）
2. 防衛関連株（言及数: 8 件）

💎 風が吹けば桶屋が儲かる銘柄 TOP3

🥇 住友電工（5802）
確度: ⭐⭐⭐⭐⭐⭐⭐⭐☆☆ (8/10)
連想: AI需要増→DC建設→電力急増→送電部材→住友電工
理由: データセンター向け電力インフラ需要の恩恵
リスク: 原材料価格の上昇

...

📈 市場センチメント
AI・半導体への強気姿勢が継続。個人投資家の押し目買い意欲は高い。

⚠️ 本レポートは AI 分析による参考情報です。
投資判断は自己責任でお願いします。
```

### ヘルスチェック

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "uptime_human": "3時間 22分",
  "schedule": { "morning": "08:00 JST (毎日)", "night": "20:00 JST (毎日)" },
  "accounts": { "total": 86, "enabled": 86 },
  "env": { "LINE_CHANNEL_ACCESS_TOKEN": true, "OPENAI_API_KEY": true }
}
```

### 監視アカウントの追加・変更

`config/accounts.json` を編集するだけで反映されます:

```json
{
  "username": "追加したいXユーザー名",
  "category": "個人投資家・トレーダー",
  "weight": 1.0,
  "enabled": true
}
```

`enabled: false` で一時的に無効化できます。

---

## 投稿取得の仕組み

X（Twitter）の公式 API を使わず、以下の方法を優先順位順に試みます:

| 優先度 | 方法 | 説明 |
|:---:|:---|:---|
| 1 | **RSS Bridge** | ローカルの Docker コンテナ経由で RSS 取得。最安定。 |
| 2 | **Nitter RSS** | 公開 Nitter インスタンスから RSS 取得。複数インスタンスで自動フォールバック。 |
| 3 | **直接スクレイピング** | x.com を axios+cheerio でパース。JS レンダリング壁あり・最終手段。 |

Nitter インスタンスが応答しない場合は 30 分後に自動復帰を試みます。

---

## ディレクトリ構成

```
kabu-line-bot/
├── src/
│   ├── scraper/
│   │   ├── tweetFetcher.ts   # 投稿取得（RSS Bridge / Nitter / スクレイピング）
│   │   └── index.ts          # 旧スクレイパー（互換用）
│   ├── analyzer/
│   │   └── stockAnalyzer.ts  # OpenAI による連想投資分析
│   ├── line/
│   │   ├── lineMessenger.ts  # Flex Message 生成・ブロードキャスト
│   │   └── index.ts          # 旧メッセンジャー（互換用）
│   ├── scheduler/
│   │   ├── cronJob.ts        # cron スケジューラー + CLI
│   │   └── index.ts          # 旧スケジューラー（互換用）
│   └── index.ts              # エントリーポイント
├── config/
│   └── accounts.json         # 監視アカウント一覧（86件）
├── logs/                     # 実行ログ（JSONL 形式、日付別）
├── tmp/                      # 投稿キャッシュ
├── rss-bridge/
│   └── whitelist.txt         # RSS-Bridge 有効ブリッジ
├── docker-compose.yml
├── nodemon.json
├── .env.example
├── package.json
└── tsconfig.json
```

---

## トラブルシューティング

### Nitter インスタンスが全滅した場合

**症状:** `[nitter] 全インスタンス不可` とログに出力される

**対処法:**

1. 動作している Nitter インスタンスを探す

   ```bash
   # 以下のサイトで公開インスタンスの稼働状況を確認
   # nitter.privacydev.net / nitter.poast.org / nitter.woodland.cafe
   curl -I https://nitter.privacydev.net/nikkei/rss
   # HTTP 200 が返れば生きている
   ```

2. `.env` の `NITTER_INSTANCE` を生きているインスタンスに変更

   ```env
   NITTER_INSTANCE=https://生きているインスタンス
   ```

3. `src/scraper/tweetFetcher.ts` の `NITTER_INSTANCES` 配列を更新してサーバーを再起動

4. **根本対策:** RSS-Bridge（方法①）を確実に起動しておくと Nitter 全滅の影響を受けません

   ```bash
   docker compose up -d
   ```

---

### RSS-Bridge で TwitterBridge が無効の場合

**症状:** `Bridge not whitelisted` エラー

**確認方法:**

```bash
curl -s "http://localhost:3000/?action=display&bridge=TwitterBridge&context=By+username&u=nikkei&format=Atom" | head -5
```

**対処法:**

1. `rss-bridge/whitelist.txt` に `TwitterBridge` が含まれているか確認

   ```
   TwitterBridge
   RssBridge
   FeedMergeBridge
   ```

2. コンテナを再起動

   ```bash
   docker compose down && docker compose up -d
   ```

3. それでも動かない場合はイメージを最新に更新

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. **根本的な問題:** X（Twitter）が RSS-Bridge のリクエストをブロックしている場合、
   TwitterBridge 自体が機能しないことがあります。その場合は Nitter（方法②）が自動的に引き継ぎます。

---

### LINE にメッセージが届かない場合

**チェックリスト:**

```bash
# 1. トークン設定確認
npm run send-test
# → エラーが出たらトークンが正しくない

# 2. 友だち追加確認
# LINE Official Account Manager でアカウントを確認し、
# 自分で友だち追加できているか確認

# 3. ヘルスチェック
curl http://localhost:8080/health | grep LINE_CHANNEL_ACCESS_TOKEN
# → true になっていれば設定は読めている
```

---

### AI 分析が空の場合

**症状:** `stock_picks` が 0 件

**原因と対処:**

| 原因 | 対処 |
|:---|:---|
| 取得投稿が 0 件 | Nitter / RSS-Bridge の稼働確認 (`npm run fetch-only`) |
| OpenAI API の利用制限・請求設定 | [platform.openai.com](https://platform.openai.com/) で利用状況を確認 |
| JSON パースエラー（3回リトライ後） | ログ確認 (`npm run show-logs`) |

---

### ログの確認方法

```bash
# 直近 5 件の実行サマリー
npm run show-logs

# 生ログを直接確認（JSONL 形式）
cat logs/2026-03-02.log | jq .

# エラーのみ抽出
cat logs/2026-03-02.log | jq 'select(.error != null)'
```

---

## 免責事項

> ⚠️ **重要: 投資は自己責任です**
>
> 本ボットが提供する情報は、AI による自動分析に基づく **参考情報** です。
> 特定の銘柄への投資を推奨・勧誘するものではありません。
>
> - 本ボットの分析結果に基づく投資判断および損益について、開発者は一切の責任を負いません
> - 株式投資には元本割れのリスクがあります
> - 投資を行う際は、必ず公式の IR 資料・有価証券報告書等でご自身で確認してください
> - 過去の分析精度は将来の結果を保証するものではありません
>
> **本ボットを使用した時点で、上記に同意したものとみなします。**
