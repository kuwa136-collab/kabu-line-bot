/**
 * ecosystem.config.js — PM2 設定ファイル（VPS 直接デプロイ用）
 *
 * 使い方:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save          # 設定を保存
 *   pm2 startup       # OS 再起動時に自動起動
 *
 * ログ確認:
 *   pm2 logs kabu-line-bot
 *   pm2 monit
 */

module.exports = {
  apps: [
    {
      name:    "kabu-line-bot",
      script:  "dist/index.js",

      // ─── プロセス設定 ───────────────────────────────────
      instances:          1,          // cron ジョブは必ず 1 インスタンス
      exec_mode:          "fork",
      watch:              false,      // 本番では watch 無効
      max_memory_restart: "512M",     // メモリ超過時に自動再起動

      // ─── 再起動設定 ─────────────────────────────────────
      restart_delay:  5_000,     // 再起動前に 5 秒待機
      max_restarts:   10,        // 連続失敗上限
      min_uptime:     "30s",     // 30 秒以上生存しないと再起動カウント増加

      // ─── ログ設定 ───────────────────────────────────────
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file:      "logs/pm2-error.log",
      out_file:        "logs/pm2-out.log",
      merge_logs:      true,

      // ─── 本番環境変数（.env から読むが補完として定義）──
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV:    "production",
        HEALTH_PORT: "8080",
      },
    },
  ],
};
