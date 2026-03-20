/**
 * index.ts — アプリケーションエントリーポイント
 *
 * 起動順序:
 *   1. 環境変数ロード・検証
 *   2. ヘルスチェック HTTP サーバー起動（:8080）
 *   3. cron スケジューラー起動
 *   4. graceful shutdown ハンドラー登録
 */

import * as dotenv from "dotenv";
import * as http from "http";

dotenv.config({ override: true });

import { startCron }     from "./scheduler/cronJob";
import accountsData      from "../config/accounts.json";

// ─── 定数 ──────────────────────────────────────────────────────
const HEALTH_PORT  = parseInt(process.env.HEALTH_PORT ?? "8080", 10);
const APP_VERSION  = "1.0.0";
const START_TIME   = Date.now();
const SCHEDULED_RUNS_ENABLED = process.env.SCHEDULED_RUNS_ENABLED === "1";
const OPENAI_ANALYSIS_ENABLED = process.env.OPENAI_ANALYSIS_ENABLED === "1";
const AUTO_PIPELINE_ENABLED = SCHEDULED_RUNS_ENABLED && OPENAI_ANALYSIS_ENABLED;

// ─── 環境変数定義 ──────────────────────────────────────────────
interface EnvSpec {
  key:         string;
  required:    boolean;
  description: string;
}

const ENV_SPECS: EnvSpec[] = [
  { key: "OPENAI_API_KEY",            required: OPENAI_ANALYSIS_ENABLED,  description: "OpenAI 分析"              },
  { key: "OPENAI_ANALYSIS_ENABLED",   required: false, description: "OpenAI 分析実行 (1で有効)"   },
  { key: "RSS_BRIDGE_URL",            required: false, description: "RSS Bridge URL"           },
  { key: "NITTER_INSTANCE",           required: false, description: "Nitter フォールバック URL" },
  { key: "PAGES_SITE_URL",            required: false, description: "GitHub Pages 固定URL"     },
  { key: "PAGES_AUTO_PUSH",           required: false, description: "docs の git 自動 push"    },
  { key: "SCHEDULED_RUNS_ENABLED",    required: false, description: "定時実行 (1で有効)"          },
];

// ─── 環境変数検証 ──────────────────────────────────────────────
interface EnvCheckResult {
  allRequiredSet: boolean;
  missing:        string[];
  table:          string;
}

function checkEnv(): EnvCheckResult {
  const missing: string[] = [];
  const rows: string[]    = [];

  const colW = Math.max(...ENV_SPECS.map((e) => e.key.length)) + 2;

  for (const spec of ENV_SPECS) {
    const set    = !!process.env[spec.key];
    const icon   = set ? "✅" : spec.required ? "❌" : "⚠️ ";
    const status = set ? "設定済み" : spec.required ? "未設定 (必須)" : "未設定 (任意)";
    rows.push(`  ${icon}  ${spec.key.padEnd(colW)} ${status.padEnd(18)}  ${spec.description}`);
    if (!set && spec.required) missing.push(spec.key);
  }

  return {
    allRequiredSet: missing.length === 0,
    missing,
    table: rows.join("\n"),
  };
}

// ─── アップタイム整形 ──────────────────────────────────────────
function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}日 ${h}時間 ${m}分`;
  if (h > 0) return `${h}時間 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

// ─── ヘルスチェック HTTP サーバー ──────────────────────────────
function createHealthServer(): http.Server {
  const accounts = accountsData.accounts;

  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";

    // ルーティング
    if (url === "/health" || url === "/status" || url === "/") {
      const uptimeMs = Date.now() - START_TIME;

      const envStatus = Object.fromEntries(
        ENV_SPECS.map((e) => [e.key, !!process.env[e.key]])
      );

      const categoryCount = accounts.reduce<Record<string, number>>((acc, a) => {
        acc[a.category] = (acc[a.category] ?? 0) + 1;
        return acc;
      }, {});

      const body = JSON.stringify(
        {
          status:          "ok",
          version:         APP_VERSION,
          node_version:    process.version,
          uptime_ms:       uptimeMs,
          uptime_human:    formatUptime(uptimeMs),
          started_at:      new Date(START_TIME).toISOString(),
          schedule: {
            enabled:  AUTO_PIPELINE_ENABLED,
            requested: SCHEDULED_RUNS_ENABLED,
            openai_analysis_enabled: OPENAI_ANALYSIS_ENABLED,
            morning:  "08:00 JST (毎日)",
            night:    "20:00 JST (毎日)",
            timezone: "Asia/Tokyo",
          },
          accounts: {
            total:    accounts.length,
            enabled:  accounts.filter((a) => a.enabled).length,
            disabled: accounts.filter((a) => !a.enabled).length,
            by_category: categoryCount,
          },
          env: envStatus,
        },
        null,
        2
      );

      res.writeHead(200, {
        "Content-Type":  "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
      });
      res.end(body);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\nAvailable: /health");
  });

  return server;
}

// ─── Graceful Shutdown ─────────────────────────────────────────
function setupGracefulShutdown(server: http.Server): void {
  const FORCE_EXIT_MS = 10_000;

  function shutdown(signal: string): void {
    console.log(`\n[shutdown] ${signal} 受信 — シャットダウン中...`);

    server.close(() => {
      console.log("[shutdown] HTTP サーバー停止");
      console.log("[shutdown] 完了 — プロセス終了");
      process.exit(0);
    });

    // タイムアウト強制終了
    const timer = setTimeout(() => {
      console.error(`[shutdown] ${FORCE_EXIT_MS / 1000}s 経過 — 強制終了`);
      process.exit(1);
    }, FORCE_EXIT_MS);

    // タイマーがプロセス終了を妨げないようにする
    if (timer.unref) timer.unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  // 予期しないエラーはログだけ残してプロセスは継続
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.warn("[unhandledRejection]", reason);
  });
}

// ─── 起動バナー ────────────────────────────────────────────────
function printBanner(): void {
  const line = "═".repeat(58);
  const now  = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  console.log(`
${line}
  株クラ AI 分析 Pages Bot  v${APP_VERSION}
  起動日時: ${now}
${line}`);
}

// ─── メイン ────────────────────────────────────────────────────
async function main(): Promise<void> {
  printBanner();

  // 1. 環境変数チェック
  console.log("\n【環境変数】");
  const env = checkEnv();
  console.log(env.table);

  if (!env.allRequiredSet) {
    console.error(
      `\n  ⚠️  必須環境変数が未設定です: ${env.missing.join(", ")}\n` +
      "  .env.example を参考に .env を作成してください。\n" +
      "  ※ 起動は続行しますが、該当機能は無効になります。\n"
    );
  }

  // 2. ヘルスチェックサーバー起動
  const server = createHealthServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(HEALTH_PORT, () => {
      console.log(
        `\n[health] HTTP サーバー起動: http://localhost:${HEALTH_PORT}/health`
      );
      resolve();
    });
  });

  // 3. Graceful Shutdown ハンドラー登録
  setupGracefulShutdown(server);

  // 4. cron スケジューラー起動
  if (AUTO_PIPELINE_ENABLED) {
    startCron();
  } else {
    console.log(
      "\n[schedule] 自動実行は停止中です。" +
      " SCHEDULED_RUNS_ENABLED=1 と OPENAI_ANALYSIS_ENABLED=1 の両方があるときだけ" +
      " cron を起動します。"
    );
  }
}

main().catch((err) => {
  console.error("[main] 致命エラー:", err);
  process.exit(1);
});
