/**
 * cronJob.ts
 * GitHub Pages 向けの定時実行・CLI エントリ。
 */

import * as dotenv from "dotenv";
import cron from "node-cron";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config({ override: true });

const DEAD_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEAD_PROXY_PORTS = new Set(["9"]);
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "GIT_HTTP_PROXY",
  "GIT_HTTPS_PROXY",
] as const;

function isDeadProxyValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;

  try {
    const target = normalized.includes("://")
      ? new URL(normalized)
      : new URL(`http://${normalized}`);
    return DEAD_PROXY_HOSTS.has(target.hostname.toLowerCase()) &&
      DEAD_PROXY_PORTS.has(target.port || "80");
  } catch {
    return /(?:127\.0\.0\.1|localhost|\[::1\])(?::9)(?:\/|$)/i.test(normalized);
  }
}

function sanitizeBrokenProxyEnv(): void {
  const clearedKeys = PROXY_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    if (typeof value !== "string" || !isDeadProxyValue(value)) return false;
    delete process.env[key];
    return true;
  });

  if (clearedKeys.length > 0) {
    console.warn(
      `[env] dead proxy env cleared: ${clearedKeys.join(", ")}`
    );
  }
}

sanitizeBrokenProxyEnv();

import { fetchAllTweets } from "../scraper/tweetFetcher";
import { analyzeTweets, formatAnalysisForLog } from "../analyzer/stockAnalyzer";
import { previewMessage } from "../line/lineMessenger";
import type { AccountConfig } from "../scraper/tweetFetcher";
import accountsData from "../../config/accounts.json";

const execFileAsync = promisify(execFile);

interface RunStats {
  accounts_total: number;
  accounts_enabled: number;
  tweets_fetched: number;
  fetch_methods: Record<string, number>;
  themes_found: number;
  picks_count: number;
  docs_updated: boolean;
  git_pushed: boolean;
  git_status?: GitPublishStatus;
  git_message?: string;
}

interface RunLog {
  timestamp: string;
  session: string;
  slot: string;
  duration_ms: number;
  stats: RunStats;
  error: string | null;
}

type GitPublishResult = {
  attempted: boolean;
  pushed: boolean;
  status: GitPublishStatus;
  message: string;
};

type GitPublishStatus = "disabled" | "skipped" | "no_changes" | "pushed" | "failed";

const LOG_DIR = path.resolve(__dirname, "../../logs");
const DOCS_DIR = path.resolve(__dirname, "../../docs");
const DOCS_INDEX_PATH = path.join(DOCS_DIR, "index.html");
const DOCS_JSON_PATH = path.join(DOCS_DIR, "latest-analysis-full.json");
const DOCS_MD_PATH = path.join(DOCS_DIR, "latest-analysis-full.md");
const DOCS_GIT_TARGETS = [
  "docs/index.html",
  "docs/latest-analysis-full.json",
  "docs/latest-analysis-full.md",
] as const;
const accounts = accountsData.accounts as AccountConfig[];

const CRON_MORNING = "0 8 * * *";
const CRON_NIGHT = "0 20 * * *";
const TZ = "Asia/Tokyo";

const PAGES_AUTO_PUSH = process.env.PAGES_AUTO_PUSH !== "0";
const PAGES_GIT_REMOTE = (process.env.PAGES_GIT_REMOTE ?? "origin").trim() || "origin";
const PAGES_GIT_BRANCH = (process.env.PAGES_GIT_BRANCH ?? "").trim();
const PAGES_SITE_URL = (process.env.PAGES_SITE_URL ?? "").trim();
const SCHEDULED_RUNS_ENABLED = process.env.SCHEDULED_RUNS_ENABLED === "1";

function nowJst(): string {
  return new Date().toLocaleString("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getTimeSlot(date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "朝の部";
  if (h >= 12 && h < 17) return "昼の部";
  if (h >= 17 && h < 23) return "夜の部";
  return "深夜の部";
}

function makeSessionId(): string {
  return new Date()
    .toLocaleString("ja-JP", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
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
  console.log(`[Step ${n}/${total}] 完了${detail ? ` - ${detail}` : ""}`);
}

function printStepWarn(n: number, total: number, detail: string): void {
  console.warn(`[Step ${n}/${total}] 警告 - ${detail}`);
}

async function ensurePagesArtifacts(): Promise<string> {
  const files = [DOCS_INDEX_PATH, DOCS_JSON_PATH, DOCS_MD_PATH];
  await Promise.all(files.map((file) => fs.access(file)));
  return files.map((file) => path.basename(file)).join(", ");
}

async function runGit(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: path.resolve(__dirname, "../.."),
    windowsHide: true,
  });
  return `${stdout}${stderr}`.trim();
}

async function syncPagesToGit(session: string): Promise<GitPublishResult> {
  if (!PAGES_AUTO_PUSH) {
    return {
      attempted: false,
      pushed: false,
      status: "disabled",
      message: "PAGES_AUTO_PUSH=0 のため skip",
    };
  }

  try {
    await fs.access(path.resolve(__dirname, "../../.git"));
  } catch {
    return {
      attempted: true,
      pushed: false,
      status: "skipped",
      message: ".git がないため skip",
    };
  }

  try {
    await runGit(["add", ...DOCS_GIT_TARGETS]);
    const staged = await runGit(["diff", "--cached", "--name-only", "--", ...DOCS_GIT_TARGETS]);
    if (!staged.trim()) {
      return {
        attempted: true,
        pushed: false,
        status: "no_changes",
        message: "docs に差分なし",
      };
    }

    await runGit([
      "commit",
      "-m",
      `update pages report: ${session}`,
      "--only",
      "--",
      ...DOCS_GIT_TARGETS,
    ]);
    const pushArgs = PAGES_GIT_BRANCH
      ? ["push", PAGES_GIT_REMOTE, `HEAD:${PAGES_GIT_BRANCH}`]
      : ["push", PAGES_GIT_REMOTE];
    await runGit(pushArgs);
    return {
      attempted: true,
      pushed: true,
      status: "pushed",
      message: "git add/commit/push 完了",
    };
  } catch (error) {
    return {
      attempted: true,
      pushed: false,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyGitPublishResult(stats: RunStats, result: GitPublishResult): void {
  stats.git_pushed = result.pushed;
  stats.git_status = result.status;
  stats.git_message = result.message;
}

function isGitPublishFailure(result: GitPublishResult): boolean {
  return result.status === "failed";
}

export async function runFullPipeline(): Promise<void> {
  const start = Date.now();
  const session = makeSessionId();
  const slot = getTimeSlot();

  printBanner(`株クラ AI Pages パイプライン (${slot})`);

  const stats: RunStats = {
    accounts_total: accounts.length,
    accounts_enabled: accounts.filter((a) => a.enabled).length,
    tweets_fetched: 0,
    fetch_methods: {},
    themes_found: 0,
    picks_count: 0,
    docs_updated: false,
    git_pushed: false,
  };

  let error: string | null = null;

  try {
    printStep(1, 3, `全アカウント (${stats.accounts_enabled} 件) の投稿取得`);
    const tweets = await fetchAllTweets(accounts);
    stats.tweets_fetched = tweets.length;

    for (const t of tweets) {
      stats.fetch_methods[t.source] = (stats.fetch_methods[t.source] ?? 0) + 1;
    }
    const methodSummary = Object.entries(stats.fetch_methods)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    printStepDone(1, 3, methodSummary ? `${tweets.length} 件 (${methodSummary})` : `${tweets.length} 件`);

    printStep(2, 3, tweets.length === 0 ? "0件日レポートと docs 出力更新" : "OpenAI 分析と docs 出力更新");
    const result = await analyzeTweets(tweets);
    stats.themes_found = result.trending_themes.length;
    stats.picks_count = result.stock_picks.length;
    console.log("\n" + formatAnalysisForLog(result));

    const docsDetail = await ensurePagesArtifacts();
    stats.docs_updated = true;
    printStepDone(2, 3, `docs 更新済み (${docsDetail})`);
    if (tweets.length === 0) {
      console.warn("[pipeline] 投稿取得 0 件のため、背景相場中心の 0件日レポートを docs に出力しました");
    }

    printStep(3, 3, "GitHub Pages 公開用の git 同期");
    const gitResult = await syncPagesToGit(tweets.length === 0 ? `${session}-empty-day` : session);
    applyGitPublishResult(stats, gitResult);
    if (isGitPublishFailure(gitResult)) {
      printStepWarn(3, 3, gitResult.message);
      console.warn(`[git] 自動 push は失敗しましたが、docs 更新は完了しています: ${gitResult.message}`);
    } else {
      printStepDone(3, 3, gitResult.message);
    }

    if (PAGES_SITE_URL) {
      console.log(`[pages] 固定URL: ${PAGES_SITE_URL}`);
    } else {
      console.log("[pages] 固定URLは PAGES_SITE_URL に設定するとログへ表示できます");
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[pipeline] エラー: ${error}`);
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

    const status = error ? "失敗" : "成功";
    printBanner(`Pages パイプライン ${status} ${(durationMs / 1000).toFixed(1)}s`);
  }
}

export async function runFetchOnly(): Promise<void> {
  printBanner("取得のみ実行 (--fetch-only)");

  const tweets = await fetchAllTweets(accounts, { processAllXGroups: true });
  const bySource: Record<string, number> = {};
  const byAccount: Array<{ username: string; count: number; method: string }> = [];

  for (const t of tweets) {
    bySource[t.source] = (bySource[t.source] ?? 0) + 1;
  }

  const accountMap = new Map<string, { count: number; method: string }>();
  for (const t of tweets) {
    const current = accountMap.get(t.username) ?? { count: 0, method: t.source };
    accountMap.set(t.username, { count: current.count + 1, method: t.source });
  }
  accountMap.forEach((value, key) => byAccount.push({ username: key, ...value }));
  byAccount.sort((a, b) => b.count - a.count);

  console.log(`\n取得総数: ${tweets.length} 件\n`);
  console.log("【ソース別】");
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`  ${src}: ${count} 件`);
  }

  console.log("\n【アカウント別 TOP 10】");
  for (const item of byAccount.slice(0, 10)) {
    console.log(`  @${item.username}: ${item.count} 件 (${item.method})`);
  }

  console.log("\nキャッシュ更新済み");
}

export async function runSendTest(): Promise<void> {
  printBanner("Pages プレビュー (--send-test)");
  const summary = previewMessage({
    analysis_date: nowJst(),
    trending_themes: [],
    stock_picks: [],
    market_sentiment: "LINE 配信は廃止され、GitHub Pages を公開先にしています。",
  });
  console.log(summary);
  console.log(`\n[pages] docs: ${DOCS_INDEX_PATH}`);
  if (PAGES_SITE_URL) {
    console.log(`[pages] 固定URL: ${PAGES_SITE_URL}`);
  }
}

async function runShowLogs(n = 5): Promise<void> {
  printBanner(`直近 ${n} 件の実行ログ (--show-logs)`);

  try {
    const files = (await fs.readdir(LOG_DIR))
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 3);

    const entries: RunLog[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(LOG_DIR, file), "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as RunLog);
        } catch {
          // ignore malformed line
        }
      }
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    for (const entry of entries.slice(0, n)) {
      const status = entry.error ? "失敗" : "成功";
      const dur = (entry.duration_ms / 1000).toFixed(1);
      const gitLabel =
        entry.stats.git_pushed ? "push済み"
        : entry.stats.git_status === "no_changes" ? "差分なし"
        : entry.stats.git_status === "disabled" ? "無効"
        : entry.stats.git_status === "skipped" ? "skip"
        : "未push";
      console.log(
        `${status} ${entry.session} (${entry.slot}) ${dur}s\n` +
        `   取得: ${entry.stats.tweets_fetched} 件 / ` +
        `テーマ: ${entry.stats.themes_found} / ` +
        `本命: ${entry.stats.picks_count} / ` +
        `docs: ${entry.stats.docs_updated ? "更新済み" : "未更新"} / ` +
        `git: ${gitLabel}`
      );
      if (entry.error) {
        console.log(`   エラー: ${entry.error.slice(0, 160)}`);
      }
      if (entry.stats.git_status === "failed" && entry.stats.git_message) {
        console.log(`   git詳細: ${entry.stats.git_message.slice(0, 160)}`);
      }
      console.log();
    }

    if (entries.length === 0) {
      console.log("ログはまだありません。");
    }
  } catch {
    console.log("ログディレクトリが見つからないか、まだ実行ログがありません。");
  }
}

export function startCron(): void {
  cron.schedule(
    CRON_MORNING,
    () => runFullPipeline().catch((err) =>
      console.error("[cron] 朝の部 エラー:", err)
    ),
    { timezone: TZ }
  );

  cron.schedule(
    CRON_NIGHT,
    () => runFullPipeline().catch((err) =>
      console.error("[cron] 夜の部 エラー:", err)
    ),
    { timezone: TZ }
  );

  printBanner("スケジューラー起動");
  console.log(`  朝の部: 毎日 08:00 JST (${CRON_MORNING})`);
  console.log(`  夜の部: 毎日 20:00 JST (${CRON_NIGHT})`);
  console.log(`  docs 出力: ${DOCS_DIR}`);
  console.log(`  監視アカウント: ${accounts.filter((a) => a.enabled).length} 件`);
  console.log(`  git 自動 push: ${PAGES_AUTO_PUSH ? "有効" : "無効"}`);
  if (PAGES_SITE_URL) {
    console.log(`  固定URL: ${PAGES_SITE_URL}`);
  }
  console.log("\n  Ctrl+C で停止\n");
}

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
      await runShowLogs(Number.isNaN(n) ? 5 : n);
      process.exit(0);
      break;
    }

    default:
      if (!SCHEDULED_RUNS_ENABLED) {
        printBanner("自動実行は停止中");
        console.log("  SCHEDULED_RUNS_ENABLED=1 のときだけ cron を起動します。\n");
        process.exit(0);
      }
      startCron();
      break;
  }
}

main().catch((err) => {
  console.error("[cronJob] エラー:", err);
  process.exit(1);
});
