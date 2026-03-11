/**
 * cronJob.ts
 * 定時実行スケジューラー + CLI エントリーポイント
 *
 * スケジュール:
 *   朝の部 → 毎日 08:00 JST
 *   夜の部 → 毎日 20:00 JST
 *
 * CLI:
 *   --analyze     フルパイプラインを今すぐ実行
 *   --fetch-only  投稿取得のみ実行（分析・配信なし）
 *   --send-test   LINE へテストメッセージを送信
 *   --show-logs   直近 5 件の実行ログを表示
 */

import * as dotenv from "dotenv";
import cron       from "node-cron";
import * as fs    from "fs/promises";
import * as path  from "path";

dotenv.config({ override: true });

import { fetchAllTweets, loadCache }              from "../scraper/tweetFetcher";
import { analyzeTweets, formatAnalysisForLog }    from "../analyzer/stockAnalyzer";
import { broadcastAnalysis, broadcastText }       from "../line/lineMessenger";
import type { AccountConfig }                     from "../scraper/tweetFetcher";
import accountsData                               from "../../config/accounts.json";

// ─── 型定義 ────────────────────────────────────────────────────
interface RunStats {
  accounts_total:   number;
  accounts_enabled: number;
  tweets_fetched:   number;
  fetch_methods:    Record<string, number>;
  themes_found:     number;
  picks_count:      number;
  line_sent:        boolean;
}

interface RunLog {
  timestamp:   string;
  session:     string;
  slot:        string;
  duration_ms: number;
  stats:       RunStats;
  error:       string | null;
}

// ─── 定数 ──────────────────────────────────────────────────────
const LOG_DIR  = path.resolve(__dirname, "../../logs");
const accounts = accountsData.accounts as AccountConfig[];

const CRON_MORNING = "0 8 * * *";   // 毎日 08:00 JST
const CRON_NIGHT   = "0 20 * * *";  // 毎日 20:00 JST
const TZ           = "Asia/Tokyo";

// ─── ロガー ────────────────────────────────────────────────────
function nowJst(): string {
  return new Date().toLocaleString("ja-JP", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function getTimeSlot(date = new Date()): string {
  const h = date.getHours();
  if (h >= 5  && h < 12) return "朝の部";
  if (h >= 12 && h < 17) return "昼の部";
  if (h >= 17 && h < 23) return "夜の部";
  return "深夜の部";
}

function makeSessionId(): string {
  // 例: 2026-03-01_08-00
  return new Date()
    .toLocaleString("ja-JP", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    })
    .replace(/\//g, "-")
    .replace(" ", "_")
    .replace(":", "-");
}

async function writeLog(entry: RunLog): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const logFile = path.join(LOG_DIR, `${dateStr}.log`);
  await fs.appendFile(logFile, JSON.stringify(entry) + "\n", "utf-8");
  console.log(`[log] 保存: ${logFile}`);
}

function printBanner(title: string): void {
  const line = "═".repeat(58);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(`  ${nowJst()}`);
  console.log(`${line}\n`);
}

function printStep(n: number, total: number, label: string): void {
  console.log(`\n[Step ${n}/${total}] ${label}...`);
}

function printStepDone(n: number, total: number, detail = ""): void {
  console.log(`[Step ${n}/${total}] ✅ 完了${detail ? " — " + detail : ""}`);
}

// ─── フルパイプライン ──────────────────────────────────────────
export async function runFullPipeline(): Promise<void> {
  const start   = Date.now();
  const session = makeSessionId();
  const slot    = getTimeSlot();

  printBanner(`株クラ AI 分析パイプライン（${slot}）`);

  const stats: RunStats = {
    accounts_total:   accounts.length,
    accounts_enabled: accounts.filter((a) => a.enabled).length,
    tweets_fetched:   0,
    fetch_methods:    {},
    themes_found:     0,
    picks_count:      0,
    line_sent:        false,
  };

  let error: string | null = null;

  try {
    // Step 1: 投稿取得
    printStep(1, 3, `全アカウント（${stats.accounts_enabled} 件）の投稿取得`);
    const tweets = await fetchAllTweets(accounts);
    stats.tweets_fetched = tweets.length;

    // ソース別の集計
    for (const t of tweets) {
      stats.fetch_methods[t.source] =
        (stats.fetch_methods[t.source] ?? 0) + 1;
    }
    const methodSummary = Object.entries(stats.fetch_methods)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    printStepDone(1, 3, `${tweets.length} 件（${methodSummary}）`);

    if (tweets.length === 0) {
      console.warn("[pipeline] 取得投稿が 0 件 → 分析スキップ");
      await broadcastText(
        `⚠️ ${slot}の分析\n取得できた投稿が 0 件でした。\nx.com スクレイピングおよび代替ソースの状態を確認してください。`
      );
      return;
    }

    // Step 2: AI 分析
    printStep(2, 3, "OpenAI による定性分析（風が吹けば桶屋が儲かる）");
    const result = await analyzeTweets(tweets);
    stats.themes_found = result.trending_themes.length;
    stats.picks_count  = result.stock_picks.length;
    console.log("\n" + formatAnalysisForLog(result));
    printStepDone(2, 3, `テーマ ${stats.themes_found} 件 / 銘柄候補 ${stats.picks_count} 件`);

    // Step 3: LINE 配信
    printStep(3, 3, "LINE ブロードキャスト配信");
    await broadcastAnalysis(result);
    stats.line_sent = true;
    printStepDone(3, 3, "全友だちへ配信完了");

  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[pipeline] ❌ エラー: ${error}`);

    // エラーを LINE に通知（失敗しても続行）
    try {
      await broadcastText(
        `⚠️ 株クラ AI 分析エラー（${slot}）\n\n${error.slice(0, 300)}`
      );
    } catch {
      console.warn("[pipeline] LINE エラー通知の送信も失敗しました");
    }
  } finally {
    const durationMs = Date.now() - start;
    const log: RunLog = {
      timestamp: new Date().toISOString(),
      session,
      slot,
      duration_ms: durationMs,
      stats,
      error,
    };
    await writeLog(log);

    const statusIcon = error ? "❌ 失敗" : "✅ 完了";
    printBanner(`パイプライン ${statusIcon}  ${(durationMs / 1000).toFixed(1)}s`);
  }
}

// ─── 投稿取得のみ ──────────────────────────────────────────────
export async function runFetchOnly(): Promise<void> {
  printBanner("投稿取得のみ実行（--fetch-only）");

  const tweets = await fetchAllTweets(accounts, { processAllXGroups: true });

  // ソース別・アカウント別の集計
  const bySource:  Record<string, number>    = {};
  const byAccount: { username: string; count: number; method: string }[] = [];

  for (const t of tweets) {
    bySource[t.source] = (bySource[t.source] ?? 0) + 1;
  }

  // アカウント別集計（上位 10）
  const accountMap = new Map<string, { count: number; method: string }>();
  for (const t of tweets) {
    const cur = accountMap.get(t.username) ?? { count: 0, method: t.source };
    accountMap.set(t.username, { count: cur.count + 1, method: t.source });
  }
  accountMap.forEach((v, k) => byAccount.push({ username: k, ...v }));
  byAccount.sort((a, b) => b.count - a.count);

  console.log(`\n取得完了: 合計 ${tweets.length} 件\n`);

  console.log("【ソース別】");
  for (const [src, n] of Object.entries(bySource)) {
    console.log(`  ${src}: ${n} 件`);
  }

  console.log("\n【アカウント別 TOP 10】");
  for (const a of byAccount.slice(0, 10)) {
    console.log(`  @${a.username}: ${a.count} 件（${a.method}）`);
  }

  console.log(`\nキャッシュ保存済み`);
}

// ─── テストメッセージ送信 ──────────────────────────────────────
export async function runSendTest(): Promise<void> {
  printBanner("LINE テストメッセージ送信（--send-test）");

  const msg =
    "🧪 テスト送信\n\n" +
    "株クラ AI 分析ボットの動作確認です。\n" +
    `送信日時: ${nowJst()}\n\n` +
    "このメッセージが届いていれば LINE 連携は正常です。\n" +
    "━━━━━━━━━━━━\n" +
    `監視アカウント: ${accounts.filter((a) => a.enabled).length} 件\n` +
    "スケジュール: 毎日 08:00 / 20:00 JST";

  await broadcastText(msg);
  console.log("[send-test] ✅ 送信完了");
}

// ─── 直近ログ表示 ──────────────────────────────────────────────
async function runShowLogs(n = 5): Promise<void> {
  printBanner(`直近 ${n} 件の実行ログ（--show-logs）`);

  try {
    const files = (await fs.readdir(LOG_DIR))
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 3);

    const entries: RunLog[] = [];

    for (const file of files) {
      const raw   = await fs.readFile(path.join(LOG_DIR, file), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try { entries.push(JSON.parse(line) as RunLog); } catch { /* skip */ }
      }
    }

    entries.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    for (const entry of entries.slice(0, n)) {
      const status = entry.error ? "❌" : "✅";
      const dur    = (entry.duration_ms / 1000).toFixed(1);
      console.log(
        `${status} ${entry.session}（${entry.slot}）  ${dur}s\n` +
        `   取得: ${entry.stats.tweets_fetched} 件 / ` +
        `テーマ: ${entry.stats.themes_found} / ` +
        `銘柄: ${entry.stats.picks_count} / ` +
        `LINE: ${entry.stats.line_sent ? "送信済" : "未送信"}` +
        (entry.error ? `\n   ⚠️  ${entry.error.slice(0, 120)}` : "")
      );
      console.log();
    }

    if (entries.length === 0) {
      console.log("ログがまだありません。");
    }
  } catch {
    console.log("ログディレクトリが見つかりません（まだ一度も実行されていません）");
  }
}

// ─── cron スケジューラー起動 ──────────────────────────────────
export function startCron(): void {
  // 朝の部: 08:00 JST
  cron.schedule(
    CRON_MORNING,
    () => runFullPipeline().catch((err) =>
      console.error("[cron] 朝の部 致命エラー:", err)
    ),
    { timezone: TZ }
  );

  // 夜の部: 20:00 JST
  cron.schedule(
    CRON_NIGHT,
    () => runFullPipeline().catch((err) =>
      console.error("[cron] 夜の部 致命エラー:", err)
    ),
    { timezone: TZ }
  );

  printBanner("スケジューラー起動");
  console.log(`  ⏰ 朝の部: 毎日 08:00 JST  （${CRON_MORNING}）`);
  console.log(`  ⏰ 夜の部: 毎日 20:00 JST  （${CRON_NIGHT}）`);
  console.log(`  📁 ログ出力先: ${LOG_DIR}`);
  console.log(`  👥 監視アカウント: ${accounts.filter((a) => a.enabled).length} 件`);
  console.log("\n  Ctrl+C で停止\n");
}

// ─── CLI エントリーポイント ────────────────────────────────────
async function main(): Promise<void> {
  const arg = process.argv[2];

  switch (arg) {
    case "--analyze":
      await runFullPipeline();
      process.exit(0);
      break;

    case "--fetch-only":
      await runFetchOnly();
      process.exit(0);
      break;

    case "--send-test":
      await runSendTest();
      process.exit(0);
      break;

    case "--show-logs": {
      const n = parseInt(process.argv[3] ?? "5", 10);
      await runShowLogs(isNaN(n) ? 5 : n);
      process.exit(0);
      break;
    }

    default:
      startCron();
      // プロセスを常駐させる（cron が動き続ける）
      break;
  }
}

main().catch((err) => {
  console.error("[cronJob] 致命エラー:", err);
  process.exit(1);
});
