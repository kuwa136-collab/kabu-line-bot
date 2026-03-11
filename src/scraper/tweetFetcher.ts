/**
 * tweetFetcher.ts
 * 投稿・ニュース取得モジュール（Puppeteer + 代替ソース）
 *
 * 方法1: Puppeteer で x.com を直接スクレイピング
 *   - アカウントを3グループに分けてローテーション（1回30件程度）
 *   - アカウント間に 3〜5 秒のランダムディレイ
 *
 * 方法2: 代替データソース（axios + cheerio）
 *   - kabutan.jp（株探）マーケットニュース
 *   - minkabu.jp（みんかぶ）注目テーマ
 *   - finance.yahoo.co.jp ニュース
 */

import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import type { Browser, CookieParam, Page } from "puppeteer";
import * as fs from "fs/promises";
import * as path from "path";

// ─── 型定義 ────────────────────────────────────────────────────

export interface Post {
  source:    "x" | "kabutan" | "minkabu" | "yahoo";
  username:  string;
  text:      string;
  timestamp: string;  // ISO 8601
  url:       string;
  headline?: string;
  summary?: string;
  category?: string;
}

/** 後方互換エイリアス */
export type Tweet = Post;

export interface AccountConfig {
  username: string;
  category: string;
  weight:   number;
  enabled:  boolean;
}

interface FetchOptions {
  processAllXGroups?: boolean;
}

type XCardRecognition = "target_own" | "target_repost_quote" | "unrelated";

interface ExtractedXCard {
  text: string;
  timestamp: string;
  href: string;
  authorHandle: string;
  recognition: XCardRecognition;
}

interface XTimelineSnapshot {
  cards: ExtractedXCard[];
  loginSignupCtaVisible: boolean;
  targetOwnCount: number;
  targetRepostQuoteCount: number;
  unrelatedCount: number;
  latestTargetTimestamp: string;
  oldestTargetTimestamp: string;
}

interface XPostBuildResult {
  posts: Post[];
  recentCardCount: number;
  missingTimestampCount: number;
  missingTextCount: number;
  noiseRejectedCount: number;
  olderThanCutoffCount: number;
  forcedAcceptedCount: number;
}

// ─── 定数 ──────────────────────────────────────────────────────

const HOURS_LOOKBACK   = 12;
const MAX_PER_ACCOUNT  = 20;
const GROUP_SIZE       = 30;
const DELAY_MIN_MS     = 3_000;
const DELAY_MAX_MS     = 5_000;
const PAGE_TIMEOUT_MS  = 30_000;
const WAIT_TIMEOUT_MS  = 10_000;
const HTTP_TIMEOUT_MS  = 15_000;
const X_INITIAL_WAIT_MS = 2_500;
const X_SCROLL_WAIT_MS  = 800;
const X_SCROLL_STEPS    = 8;
const X_SCROLL_STABLE_LIMIT = 2;
const X_MIN_POSTS_WITH_FALLBACK = 2;
const YAHOO_ALLOWED_CATEGORIES = new Set([
  "経済総合",
  "市況・概況",
  "日本株",
  "外国株",
]);
const YAHOO_BLOCKED_PUBLISHERS = new Set([
  "LIMO",
  "あるじゃん（All About マネー）",
  "ダイヤモンド・ザイ",
]);
const YAHOO_BLOCKED_HEADLINE_PATTERNS = [
  /取締役が.+普通株.+売却/,
  /新NISA/,
  /住宅ローン/,
];

const ROTATION_FILE = path.resolve(__dirname, "../../tmp/rotation.json");
const CACHE_FILE    = path.resolve(__dirname, "../../tmp/tweets_cache.json");
const X_DEBUG_DIR   = path.resolve(__dirname, "../../tmp/x-debug");
const DEFAULT_X_COOKIES_FILE = path.resolve(__dirname, "../../tmp/x-cookies.json");
const X_DEBUG_ACCOUNT = (process.env.X_DEBUG_ACCOUNT ?? "").trim().toLowerCase();
const X_DEBUG_EXTRACT_LIMIT = 5;
const SCRAPER_DEBUG = process.env.SCRAPER_DEBUG === "1";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

let xDebugSaved = false;
let xCookieLogDone = false;
let xCookiesCache: CookieParam[] | null | undefined;

// ─── ユーティリティ ────────────────────────────────────────────

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(): Promise<void> {
  const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeXUsername(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/^https?:\/\/x\.com\//i, "").replace(/\/+$/, "").toLowerCase();
}

function cutoffTime(): Date {
  return new Date(Date.now() - HOURS_LOOKBACK * 60 * 60 * 1_000);
}

function isDebugAccount(username: string): boolean {
  return !!X_DEBUG_ACCOUNT && normalizeXUsername(username) === X_DEBUG_ACCOUNT;
}

function shouldLogScraperDebug(username?: string): boolean {
  return SCRAPER_DEBUG || (!!username && isDebugAccount(username));
}

function logScraperDebug(message: string, username?: string): void {
  if (!shouldLogScraperDebug(username)) return;
  console.log(message);
}

function toIsoOrNull(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeArticleText(raw: string): string {
  return cleanText(raw.replace(/続きを読む/g, " "));
}

function buildNewsText(headline: string, summary?: string): string {
  const trimmedHeadline = cleanText(headline);
  const trimmedSummary = cleanText(summary ?? "");
  if (!trimmedSummary) return trimmedHeadline;
  if (trimmedSummary.includes(trimmedHeadline)) return trimmedSummary;
  return `${trimmedHeadline} ${trimmedSummary}`.trim();
}

function shouldKeepYahooArticle(publisher: string, headline: string): boolean {
  if (YAHOO_BLOCKED_PUBLISHERS.has(cleanText(publisher))) return false;
  return !YAHOO_BLOCKED_HEADLINE_PATTERNS.some((pattern) => pattern.test(headline));
}

function extractJsonObjectAfterKey(html: string, key: string): string | null {
  const marker = `"${key}":`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const objectStart = html.indexOf("{", markerIndex + marker.length);
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return html.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function dedupePostsByUrl(posts: Post[]): Post[] {
  const seen = new Set<string>();
  const deduped: Post[] = [];

  for (const post of posts) {
    const key = post.url || `${post.source}|${post.timestamp}|${post.headline ?? post.text}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(post);
  }

  return deduped;
}

function isLikelyNewsTime(text: string): boolean {
  return (
    /^(?:\d{1,2}:\d{2}|今日\s+\d{1,2}:\d{2}|本日\s+\d{1,2}:\d{2}|昨日\s+\d{1,2}:\d{2})$/.test(text) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)
  );
}

function toErrorMessage(err: unknown): string {
  if (err instanceof AxiosError) return `HTTP ${err.response?.status ?? "?"} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function logXCookieState(message: string): void {
  if (xCookieLogDone) return;
  xCookieLogDone = true;
  console.log(message);
}

function normalizeSameSite(value: unknown): CookieParam["sameSite"] | undefined {
  if (typeof value !== "string") return undefined;

  switch (value.trim().toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
    case "no_restriction":
    case "norestriction":
      return "None";
    default:
      return undefined;
  }
}

function normalizeCookie(raw: unknown): CookieParam | null {
  if (!raw || typeof raw !== "object") return null;

  const cookie = raw as Record<string, unknown>;
  const name = typeof cookie.name === "string" ? cookie.name : "";
  const value = typeof cookie.value === "string" ? cookie.value : "";

  if (!name) return null;

  const normalized: CookieParam = { name, value };

  if (typeof cookie.domain === "string" && cookie.domain) normalized.domain = cookie.domain;
  if (typeof cookie.path === "string" && cookie.path) normalized.path = cookie.path;
  if (typeof cookie.url === "string" && cookie.url) normalized.url = cookie.url;
  if (!normalized.domain && !normalized.url) normalized.url = "https://x.com";
  if (typeof cookie.httpOnly === "boolean") normalized.httpOnly = cookie.httpOnly;
  if (typeof cookie.secure === "boolean") normalized.secure = cookie.secure;
  if (typeof cookie.expires === "number" && Number.isFinite(cookie.expires)) {
    normalized.expires = cookie.expires;
  }

  const sameSite = normalizeSameSite(cookie.sameSite);
  if (sameSite) normalized.sameSite = sameSite;

  return normalized;
}

async function loadXCookies(): Promise<CookieParam[] | null> {
  if (xCookiesCache !== undefined) return xCookiesCache;

  const cookiesJson = (process.env.X_COOKIES_JSON ?? "").trim();
  const cookiesFile = (process.env.X_COOKIES_FILE ?? "").trim() || DEFAULT_X_COOKIES_FILE;

  let rawText = "";
  let sourceLabel = "";

  if (cookiesJson) {
    rawText = cookiesJson;
    sourceLabel = "env:X_COOKIES_JSON";
  } else {
    try {
      rawText = await fs.readFile(cookiesFile, "utf-8");
      sourceLabel = `file:${cookiesFile}`;
    } catch {
      xCookiesCache = null;
      logXCookieState("[x.com] authenticated cookies not loaded; using anonymous session");
      return xCookiesCache;
    }
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    const rawCookies = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown[] }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : [];

    const cookies = rawCookies
      .map(normalizeCookie)
      .filter((cookie): cookie is CookieParam => cookie !== null);

    if (cookies.length === 0) {
      xCookiesCache = null;
      logXCookieState(
        `[x.com] authenticated cookies not loaded; no valid cookies found in ${sourceLabel}`
      );
      return xCookiesCache;
    }

    xCookiesCache = cookies;
    logXCookieState(
      `[x.com] authenticated cookies loaded (${cookies.length}) from ${sourceLabel}`
    );
    return xCookiesCache;
  } catch (err) {
    xCookiesCache = null;
    logXCookieState(
      `[x.com] authenticated cookies not loaded; invalid cookie JSON in ${sourceLabel}: ${toErrorMessage(err)}`
    );
    return xCookiesCache;
  }
}

async function saveXDebugArtifacts(
  page: Page,
  username: string,
  reason: string
): Promise<void> {
  if (!shouldLogScraperDebug(username)) return;
  if (xDebugSaved) return;
  xDebugSaved = true;

  await fs.mkdir(X_DEBUG_DIR, { recursive: true });

  const safeName = username.replace(/[^\w.-]+/g, "_");
  const prefix   = `${Date.now()}-${safeName}`;
  const htmlPath = path.join(X_DEBUG_DIR, `${prefix}.html`);
  const pngPath  = path.join(X_DEBUG_DIR, `${prefix}.png`);

  const [title, url, html, bodyText] = await Promise.all([
    page.title().catch(() => ""),
    Promise.resolve(page.url()),
    page.content().catch(() => ""),
    page.evaluate((): string => {
      const doc = (globalThis as { document?: { body?: { innerText?: string } } }).document;
      return doc?.body?.innerText ?? "";
    }).catch(() => ""),
  ]);

  const debugMarkers: Array<[RegExp, string]> = [
    [/sign in/i, "sign-in"],
    [/ログイン/, "login-ja"],
    [/create account/i, "create-account"],
    [/join x/i, "join-x"],
    [/something went wrong/i, "something-went-wrong"],
    [/try again/i, "try-again"],
    [/unusual traffic/i, "unusual-traffic"],
    [/rate limit/i, "rate-limit"],
  ];

  const markers = debugMarkers
    .filter(([pattern]) => pattern.test(bodyText))
    .map(([, label]) => label);

  await fs.writeFile(htmlPath, html, "utf-8");
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);

  console.warn(
    `[x.com][debug] @${username} ${reason} | title="${title}" | url=${url}` +
    (markers.length > 0 ? ` | markers=${markers.join(",")}` : "") +
    ` | html=${htmlPath} | screenshot=${pngPath}`
  );
}

function logExtractedTweetsForDebug(
  username: string,
  extracted: ExtractedXCard[]
): void {
  if (!shouldLogScraperDebug(username)) return;

  console.log(
    `[x.com][debug][extract] @${username} extracted=${extracted.length} (before date filtering)`
  );

  for (const tweet of extracted.slice(0, X_DEBUG_EXTRACT_LIMIT)) {
    const statusId = tweet.href.match(/\/status\/(\d+)/)?.[1] ?? "";
    const idOrUrl = tweet.href
      ? `https://x.com${tweet.href}`
      : statusId
        ? statusId
        : "n/a";
    const preview = cleanText(tweet.text).slice(0, 80);

    console.log(
      `[x.com][debug][extract] account=@${username}` +
      ` | tweet=${idOrUrl}` +
      ` | timestamp=${tweet.timestamp || "n/a"}` +
      ` | author=@${tweet.authorHandle || "n/a"}` +
      ` | recognition=${tweet.recognition}` +
      ` | text="${preview}"`
    );
  }
}

function dedupeXCards(cards: ExtractedXCard[]): ExtractedXCard[] {
  const seen = new Set<string>();
  const deduped: ExtractedXCard[] = [];

  for (const card of cards) {
    const key = card.href || `${card.timestamp}|${cleanText(card.text).slice(0, 120)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(card);
  }

  return deduped;
}

function buildPostsFromXCards(
  cards: ExtractedXCard[],
  username: string,
  cutoffIso: string
): XPostBuildResult {
  const posts: Post[] = [];
  const recentCards: Array<Pick<ExtractedXCard, "text" | "timestamp" | "href">> = [];
  let missingTimestampCount = 0;
  let missingTextCount = 0;
  let noiseRejectedCount = 0;
  let olderThanCutoffCount = 0;
  let forcedAcceptedCount = 0;

  for (const { text, timestamp, href } of cards) {
    if (!timestamp) {
      missingTimestampCount++;
      continue;
    }
    if (timestamp < cutoffIso) {
      olderThanCutoffCount++;
      continue;
    }

    recentCards.push({ text, timestamp, href });

    const cleaned = cleanText(text);
    if (!cleaned) {
      missingTextCount++;
      continue;
    }
    if (isNoise(cleaned)) {
      noiseRejectedCount++;
      continue;
    }
    posts.push({
      source:    "x",
      username,
      text:      cleaned,
      timestamp,
      url:       href ? `https://x.com${href}` : `https://x.com/${username}`,
    });
  }

  if (posts.length === 0 && recentCards.length > 0) {
    const fallbackCard = recentCards.find((card) => cleanText(card.text)) ?? recentCards[0];
    const fallbackText = cleanText(fallbackCard.text) || "(text unavailable)";
    posts.push({
      source:    "x",
      username,
      text:      fallbackText,
      timestamp: fallbackCard.timestamp,
      url:       fallbackCard.href ? `https://x.com${fallbackCard.href}` : `https://x.com/${username}`,
    });
    forcedAcceptedCount = 1;
  }

  return {
    posts,
    recentCardCount: recentCards.length,
    missingTimestampCount,
    missingTextCount,
    noiseRejectedCount,
    olderThanCutoffCount,
    forcedAcceptedCount,
  };
}

async function extractXTimelineSnapshot(
  page: Page,
  username: string
): Promise<XTimelineSnapshot> {
  const snapshot = await page.evaluate((requestedUsername): XTimelineSnapshot => {
    function normalizeHandle(value: string): string {
      return value
        .trim()
        .replace(/^@+/, "")
        .replace(/^https?:\/\/x\.com\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    }

    function parseHandleFromHref(href: string): string {
      const match = href.match(/^\/([^/?#]+)(?:\/status\/\d+)?/);
      return match?.[1] ? normalizeHandle(match[1]) : "";
    }

    function textContainsTarget(text: string, handles: string[]): boolean {
      const lower = text.toLowerCase();
      return handles.some((handle) => lower.includes(`@${handle}`) || lower.includes(handle));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document as {
      querySelector: (s: string) => {
        getAttribute?: (a: string) => string | null;
        textContent?: string | null;
      } | null;
      querySelectorAll: (s: string) => ArrayLike<{
        querySelector: (s: string) => {
          textContent?: string | null;
          getAttribute?: (a: string) => string | null;
          closest?: (s: string) => {
            getAttribute?: (a: string) => string | null;
          } | null;
        } | null;
        querySelectorAll: (s: string) => ArrayLike<{
          textContent?: string | null;
          getAttribute?: (a: string) => string | null;
          querySelector?: (s: string) => {
            getAttribute?: (a: string) => string | null;
          } | null;
        }>;
      }>;
    };

    const targetHandles = new Set<string>([normalizeHandle(requestedUsername)]);

    const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute?.("href") ?? "";
    const canonicalHandle = canonicalHref.match(/x\.com\/([^/?#]+)/i)?.[1] ?? "";
    if (canonicalHandle) targetHandles.add(normalizeHandle(canonicalHandle));

    const profileSchemaText =
      doc.querySelector('script[data-testid="UserProfileSchema-test"]')?.textContent ?? "";
    if (profileSchemaText) {
      try {
        const parsed = JSON.parse(profileSchemaText) as {
          mainEntity?: { additionalName?: string };
        };
        const additionalName = parsed.mainEntity?.additionalName ?? "";
        if (additionalName) targetHandles.add(normalizeHandle(additionalName));
      } catch {
        // ignore malformed profile schema
      }
    }

    const handles = Array.from(targetHandles).filter(Boolean);
    const loginSignupCtaVisible =
      !!doc.querySelector('[data-testid="login"], [data-testid="signup"]');

    const rawCards = Array.from(doc.querySelectorAll('article[data-testid="tweet"]'))
      .map((article) => {
        const text =
          article.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
        const time = article.querySelector("time");
        const timestamp = time?.getAttribute?.("datetime") ?? "";
        const href =
          time?.closest?.("a")?.getAttribute?.("href") ??
          article.querySelector('a[href*="/status/"]')?.getAttribute?.("href") ??
          "";

        const authorHandle = parseHandleFromHref(
          article.querySelector('[data-testid="User-Name"] a[href^="/"], [data-testid="UserName"] a[href^="/"]')
            ?.getAttribute?.("href") ?? ""
        );

        const socialContext = article.querySelector('[data-testid="socialContext"]');
        const socialContextText = socialContext?.textContent ?? "";
        const socialContextHandles = Array.from(
          article.querySelectorAll('[data-testid="socialContext"] a[href^="/"]')
        )
          .map((anchor) => parseHandleFromHref(anchor.getAttribute?.("href") ?? ""))
          .filter(Boolean);

        const statusAuthors = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map((anchor) => parseHandleFromHref(anchor.getAttribute?.("href") ?? ""))
          .filter(Boolean);

        const isTargetOwn =
          !!authorHandle && handles.includes(authorHandle);
        const isTargetRepostQuote =
          !isTargetOwn &&
          (
            socialContextHandles.some((handle) => handles.includes(handle)) ||
            textContainsTarget(socialContextText, handles) ||
            statusAuthors.some((handle) => handles.includes(handle))
          );

        const recognition: XCardRecognition =
          isTargetOwn ? "target_own" :
          isTargetRepostQuote ? "target_repost_quote" :
          "unrelated";

        return {
          text,
          timestamp,
          href,
          authorHandle,
          recognition,
        };
      })
      .filter((card) => Boolean(card.text || card.timestamp || card.href));

    const cards = Array.from(
      rawCards.reduce((map, card) => {
        const key = card.href || `${card.timestamp}|${card.text.slice(0, 120)}`;
        if (!key || map.has(key)) return map;
        map.set(key, card);
        return map;
      }, new Map<string, ExtractedXCard>()).values()
    );

    const targetCards = cards.filter((card) => card.recognition !== "unrelated");
    const targetTimestamps = targetCards
      .map((card) => card.timestamp)
      .filter(Boolean)
      .sort();

    return {
      cards,
      loginSignupCtaVisible,
      targetOwnCount: cards.filter((card) => card.recognition === "target_own").length,
      targetRepostQuoteCount: cards.filter((card) => card.recognition === "target_repost_quote").length,
      unrelatedCount: cards.filter((card) => card.recognition === "unrelated").length,
      latestTargetTimestamp: targetTimestamps[targetTimestamps.length - 1] ?? "",
      oldestTargetTimestamp: targetTimestamps[0] ?? "",
    };
  }, normalizeXUsername(username));

  snapshot.cards = dedupeXCards(snapshot.cards);
  snapshot.targetOwnCount = snapshot.cards.filter((card) => card.recognition === "target_own").length;
  snapshot.targetRepostQuoteCount = snapshot.cards.filter((card) => card.recognition === "target_repost_quote").length;
  snapshot.unrelatedCount = snapshot.cards.filter((card) => card.recognition === "unrelated").length;

  const targetTimestamps = snapshot.cards
    .filter((card) => card.recognition !== "unrelated")
    .map((card) => card.timestamp)
    .filter(Boolean)
    .sort();

  snapshot.latestTargetTimestamp = targetTimestamps[targetTimestamps.length - 1] ?? "";
  snapshot.oldestTargetTimestamp = targetTimestamps[0] ?? "";

  return snapshot;
}

/** HTMLタグ・URL・RT接頭辞・画像リンクを除去する */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g,  "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/pic\.twitter\.com\/\S+/g, "")
    .replace(/^RT\s+@\w+:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** システムエラー系・空テキスト等のノイズ投稿を判定する */
function isNoise(text: string): boolean {
  if (!text || text.length < 8) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("error") ||
    lower.includes("取得できません") ||
    lower.includes("not found") ||
    lower.includes("service unavailable") ||
    lower.includes("503") ||
    lower.includes("429") ||
    lower.includes("something went wrong") ||
    lower.includes("try again") ||
    /^[\s\W]*$/.test(text)
  );
}

// ─── グループローテーション ────────────────────────────────────

/** 今回処理するグループのインデックスを取得し、次回用にカウンターを進める */
async function readRotationIndex(numGroups: number): Promise<number> {
  try {
    const raw     = await fs.readFile(ROTATION_FILE, "utf-8");
    const { index } = JSON.parse(raw) as { index: number };
    const current = index % numGroups;
    const next    = (current + 1) % numGroups;
    await fs.writeFile(ROTATION_FILE, JSON.stringify({ index: next }));
    return current;
  } catch {
    await fs.mkdir(path.dirname(ROTATION_FILE), { recursive: true });
    await fs.writeFile(ROTATION_FILE, JSON.stringify({ index: 1 }));
    return 0;
  }
}

// ─── 方法 1: Puppeteer x.com スクレイピング ───────────────────

async function fetchAccountViaPuppeteer(
  username: string,
  browser: Browser,
  xCookies: CookieParam[] | null
): Promise<Post[]> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(randomUA());
    await page.setViewport({ width: 1280, height: 900 });

    if (xCookies && xCookies.length > 0) {
      await page.setCookie(...xCookies);
    }

    // 画像・フォント・メディアをブロックして高速化
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "media"].includes(req.resourceType())) {
        void req.abort();
      } else {
        void req.continue();
      }
    });

    await page.goto(`https://x.com/${username}`, {
      waitUntil: "domcontentloaded",
      timeout:   PAGE_TIMEOUT_MS,
    });

    await waitMs(X_INITIAL_WAIT_MS);
    await page
      .waitForSelector('article[data-testid="tweet"]', { timeout: WAIT_TIMEOUT_MS })
      .catch(() => undefined);

    const cutoffIso = cutoffTime().toISOString();
    let snapshot = await extractXTimelineSnapshot(page, username);
    let stablePasses = 0;

    for (let i = 0; i < X_SCROLL_STEPS; i++) {
      const prevCardCount = snapshot.cards.length;
      const prevTargetCount = snapshot.targetOwnCount + snapshot.targetRepostQuoteCount;
      const prevOldestTargetTimestamp = snapshot.oldestTargetTimestamp;

      await page.evaluate(() => {
        const win = globalThis as unknown as {
          scrollBy: (x: number, y: number) => void;
          innerHeight?: number;
        };
        win.scrollBy(0, Math.floor((win.innerHeight ?? 800) * 0.9));
      });
      await waitMs(X_SCROLL_WAIT_MS);

      const nextSnapshot = await extractXTimelineSnapshot(page, username);
      const nextTargetCount = nextSnapshot.targetOwnCount + nextSnapshot.targetRepostQuoteCount;
      const reachedTargetLookback =
        !!nextSnapshot.oldestTargetTimestamp && nextSnapshot.oldestTargetTimestamp < cutoffIso;
      const progressed =
        nextSnapshot.cards.length > prevCardCount ||
        nextTargetCount > prevTargetCount ||
        nextSnapshot.oldestTargetTimestamp !== prevOldestTargetTimestamp;

      stablePasses = progressed ? 0 : stablePasses + 1;
      snapshot = nextSnapshot;

      if (reachedTargetLookback && nextTargetCount > 0 && stablePasses >= 1) {
        break;
      }

      if (stablePasses >= X_SCROLL_STABLE_LIMIT && nextSnapshot.cards.length > 0) {
        break;
      }
    }

    const recognizedCards = snapshot.cards.filter((card) => card.recognition !== "unrelated");
    const latestExtractedTimestamp = snapshot.cards
      .map((card) => card.timestamp)
      .find(Boolean) ?? "";
    const genericBuild = buildPostsFromXCards(snapshot.cards, username, cutoffIso);
    const preferredBuild = buildPostsFromXCards(
      recognizedCards.length > 0 ? recognizedCards : snapshot.cards,
      username,
      cutoffIso
    );
    const genericPosts = genericBuild.posts;
    let posts = preferredBuild.posts;
    let usedGenericFallback = false;
    let supplementedGenericCount = 0;

    if (posts.length === 0 && recognizedCards.length > 0) {
      if (genericPosts.length > 0) {
        posts = genericPosts;
        usedGenericFallback = true;
      }
    } else if (recognizedCards.length > 0 && posts.length < X_MIN_POSTS_WITH_FALLBACK) {
      const existingUrls = new Set(posts.map((post) => post.url));
      for (const post of genericPosts) {
        if (existingUrls.has(post.url)) continue;
        posts.push(post);
        existingUrls.add(post.url);
        supplementedGenericCount++;
        if (posts.length >= X_MIN_POSTS_WITH_FALLBACK) break;
      }
    }

    if (shouldLogScraperDebug(username)) {
      console.log(
        `[x.com][debug][post-scroll] @${username}` +
        ` | extractedCards=${snapshot.cards.length}` +
        ` | targetOwn=${snapshot.targetOwnCount}` +
        ` | targetRepostQuote=${snapshot.targetRepostQuoteCount}` +
        ` | excludedUnrelated=${snapshot.unrelatedCount}` +
        ` | latestTargetTimestamp=${snapshot.latestTargetTimestamp || "n/a"}` +
        ` | latestExtractedTimestamp=${latestExtractedTimestamp || "n/a"}` +
        ` | loginSignupCtaVisible=${snapshot.loginSignupCtaVisible}` +
        ` | usedGenericFallback=${usedGenericFallback}` +
        ` | supplementedGenericCount=${supplementedGenericCount}` +
        ` | recentRecognizedCards=${preferredBuild.recentCardCount}` +
        ` | missingText=${preferredBuild.missingTextCount}` +
        ` | noiseRejected=${preferredBuild.noiseRejectedCount}` +
        ` | forcedAccepted=${preferredBuild.forcedAcceptedCount}`
      );
    }

    logExtractedTweetsForDebug(username, snapshot.cards);

    if (snapshot.cards.length === 0) {
      await saveXDebugArtifacts(
        page,
        username,
        "tweet selector not found"
      );
    }

    if (snapshot.cards.length > 0 && posts.length === 0) {
      await saveXDebugArtifacts(page, username, "tweets extracted but filtered");
      if (shouldLogScraperDebug(username)) {
        console.warn(
          `[x.com][debug] @${username} extracted=${snapshot.cards.length}` +
          ` targetOwn=${snapshot.targetOwnCount}` +
          ` targetRepostQuote=${snapshot.targetRepostQuoteCount}` +
          ` filtered=0 cutoff=${cutoffIso}` +
          ` latestTarget=${snapshot.latestTargetTimestamp || "n/a"}` +
          ` latestExtracted=${latestExtractedTimestamp || "n/a"}` +
          ` recentRecognizedCards=${preferredBuild.recentCardCount}` +
          ` missingText=${preferredBuild.missingTextCount}` +
          ` noiseRejected=${preferredBuild.noiseRejectedCount}`
        );
      }
    }

    return posts.slice(0, MAX_PER_ACCOUNT);
  } catch (err) {
    console.warn(`[x.com] @${username}: ${toErrorMessage(err)}`);
    return [];
  } finally {
    await page.close();
  }
}

async function fetchXPosts(
  accounts: AccountConfig[],
  options: FetchOptions = {}
): Promise<Post[]> {
  const enabled    = accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return [];
  const numGroups  = Math.ceil(enabled.length / GROUP_SIZE);
  const groups = options.processAllXGroups
    ? Array.from({ length: numGroups }, (_, i) => ({
        index: i,
        accounts: enabled.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE),
      }))
    : await (async () => {
        const groupIndex = await readRotationIndex(numGroups);
        return [{
          index: groupIndex,
          accounts: enabled.slice(
            groupIndex * GROUP_SIZE,
            (groupIndex + 1) * GROUP_SIZE
          ),
        }];
      })();

  if (options.processAllXGroups) {
    console.log(`[x.com] 全グループ処理（${numGroups} グループ / 全 ${enabled.length} 件）`);
  } else {
    console.log(
      `[x.com] グループ ${groups[0].index + 1}/${numGroups}` +
      `（${groups[0].accounts.length} アカウント / 全 ${enabled.length} 件）`
    );
  }

  let browser: Browser | null = null;
  const allPosts: Post[] = [];
  const xCookies = await loadXCookies();

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    for (const group of groups) {
      if (options.processAllXGroups) {
        console.log(
          `[x.com] グループ ${group.index + 1}/${numGroups}` +
          `（${group.accounts.length} アカウント / 全 ${enabled.length} 件）`
        );
      }

      for (let i = 0; i < group.accounts.length; i++) {
        const account = group.accounts[i];
        if (SCRAPER_DEBUG) {
          console.log(`[x.com] (${i + 1}/${group.accounts.length}) @${account.username}`);
        }
        const posts = await fetchAccountViaPuppeteer(account.username, browser, xCookies);
        allPosts.push(...posts);
        logScraperDebug(`[x.com] @${account.username}: ${posts.length} 件取得`, account.username);
        if (i < group.accounts.length - 1) await randomDelay();
      }
    }
  } catch (err) {
    console.error(`[x.com] ブラウザ起動エラー: ${toErrorMessage(err)}`);
  } finally {
    await browser?.close();
  }

  console.log(`[x.com] 合計 ${allPosts.length} 件取得`);
  return allPosts;
}

export async function debugFetchXPosts(
  accounts: AccountConfig[],
  options?: FetchOptions
): Promise<Post[]> {
  return fetchXPosts(accounts, options);
}

// ─── 方法 2: 代替データソース ─────────────────────────────────

/** "10:30", "03/01 10:30", "2026-03-01" 等を Date に変換 */
function parseJpTime(text: string): Date | null {
  if (!text) return null;
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const now = new Date();

  const relative = normalized.match(/^(今日|本日|昨日)\s+(\d{1,2}):(\d{2})$/);
  if (relative) {
    const base = new Date(now);
    if (relative[1] === "昨日") base.setDate(base.getDate() - 1);
    base.setHours(parseInt(relative[2], 10), parseInt(relative[3], 10), 0, 0);
    return base;
  }

  // HH:MM
  const timeOnly = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const d = new Date(now);
    d.setHours(parseInt(timeOnly[1], 10), parseInt(timeOnly[2], 10), 0, 0);
    return d;
  }

  // MM/DD HH:MM または M月D日 HH:MM
  const mdHm = normalized.match(/(\d{1,2})[\/月](\d{1,2})[日]?\s+(\d{1,2}):(\d{2})/);
  if (mdHm) {
    return new Date(
      now.getFullYear(),
      parseInt(mdHm[1], 10) - 1,
      parseInt(mdHm[2], 10),
      parseInt(mdHm[3], 10),
      parseInt(mdHm[4], 10)
    );
  }

  const mdOnly = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdOnly) {
    let year = now.getFullYear();
    const month = parseInt(mdOnly[1], 10);
    const day = parseInt(mdOnly[2], 10);
    const candidate = new Date(year, month - 1, day, 23, 59, 59, 999);
    if (candidate.getTime() - now.getTime() > 36 * 60 * 60 * 1_000) {
      year -= 1;
    }
    return new Date(year, month - 1, day, 23, 59, 59, 999);
  }

  const ymdHm = normalized.match(
    /^(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?$/
  );
  if (ymdHm) {
    return new Date(
      parseInt(ymdHm[1], 10),
      parseInt(ymdHm[2], 10) - 1,
      parseInt(ymdHm[3], 10),
      parseInt(ymdHm[4] ?? "0", 10),
      parseInt(ymdHm[5] ?? "0", 10)
    );
  }

  // YYYY-MM-DD or ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

async function fetchKabutan(): Promise<Post[]> {
  const url = "https://kabutan.jp/news/marketnews/";
  try {
    const { data: html } = await axios.get<string>(url, {
      headers: { "User-Agent": randomUA(), "Accept-Language": "ja-JP,ja;q=0.9" },
      timeout: HTTP_TIMEOUT_MS,
    });
    const $      = cheerio.load(html);
    const posts: Post[] = [];
    const cutoff = cutoffTime();

    // 株探のニュース一覧テーブル / リスト
    $("table.s_news_list tr").each((_, el) => {
      const titleEl = $(el).find('td a[href*="/news/marketnews/"]').first();
      const headline = cleanText(titleEl.text());
      const href = titleEl.attr("href") ?? "";
      if (!headline || headline.length < 5 || !href) return;

      const link = href.startsWith("http") ? href : `https://kabutan.jp${href}`;
      const category = cleanText($(el).find(".newslist_ctg").first().text());
      const timeEl = $(el).find("td.news_time time").first();
      const timestamp = toIsoOrNull(
        parseJpTime(timeEl.attr("datetime") ?? "") ??
        parseJpTime(timeEl.text().trim())
      );
      if (!timestamp || timestamp < cutoff.toISOString()) return;
      if (isNoise(headline)) return;

      posts.push({
        source: "kabutan",
        username: "kabutan_news",
        text: headline,
        timestamp,
        url: link,
        headline,
        summary: category ? `カテゴリ: ${category}` : undefined,
        category: category || undefined,
      });
    });

    console.log(`[kabutan] ${posts.length} 件取得`);
    return posts.slice(0, MAX_PER_ACCOUNT * 2);
  } catch (err) {
    console.warn(`[kabutan] 取得失敗: ${toErrorMessage(err)}`);
    return [];
  }
}

async function fetchMinkabu(): Promise<Post[]> {
  const url = "https://minkabu.jp/news";
  try {
    const { data: html } = await axios.get<string>(url, {
      headers: { "User-Agent": randomUA(), "Accept-Language": "ja-JP,ja;q=0.9" },
      timeout: HTTP_TIMEOUT_MS,
    });
    const $    = cheerio.load(html);
    const posts: Post[] = [];
    const cutoff = cutoffTime();

    // テーマ一覧
    $("#news_list > li").each((_, el) => {
      const item = $(el);
      const titleEl = item.find('.title_box a[href^="/news/"]').first();
      const href = titleEl.attr("href") ?? "";
      const headline = cleanText(item.attr("data-news-name") ?? titleEl.text());
      if (!headline || headline.length < 5 || !href) return;

      const link = href.startsWith("http") ? href : `https://minkabu.jp${href}`;
      const summary = normalizeArticleText(item.find(".ly_vamd_inner.vatp").first().text());
      const category = cleanText(item.find('a[href*="/news/search?category="]').first().text());
      const timeText = normalizeArticleText(item.find(".flex.items-center.justify-end").first().text());
      const timestamp = toIsoOrNull(parseJpTime(timeText));
      if (!timestamp || timestamp < cutoff.toISOString()) return;
      if (isNoise(headline)) return;
      const cleaned = headline;
      const desc = summary;

      // 親要素から説明文を取得できれば付加
      const fullText = desc ? `${cleaned}：${cleanText(desc)}` : cleaned;

      posts.push({
        source:    "minkabu",
        username:  "minkabu_news",
        text:      fullText,
        timestamp,
        url:       link,
        headline,
        summary:   summary || undefined,
        category:  category || undefined,
      });
    });

    console.log(`[minkabu] ${posts.length} 件取得`);
    return posts.slice(0, MAX_PER_ACCOUNT * 2);
  } catch (err) {
    console.warn(`[minkabu] 取得失敗: ${toErrorMessage(err)}`);
    return [];
  }
}

async function fetchYahooFinance(): Promise<Post[]> {
  const url = "https://finance.yahoo.co.jp/news/";
  try {
    const { data: html } = await axios.get<string>(url, {
      headers: { "User-Agent": randomUA(), "Accept-Language": "ja-JP,ja;q=0.9" },
      timeout: HTTP_TIMEOUT_MS,
    });
    const $      = cheerio.load(html);
    const posts: Post[] = [];
    const cutoff = cutoffTime();

    $("li, article").each((_, el) => {
      const titleEl = $(el).find("a").first();
      const title   = titleEl.text().trim();
      const href    = titleEl.attr("href") ?? "";
      if (!title || title.length < 5 || !href) return;

      const link = href.startsWith("http") ? href : `https://finance.yahoo.co.jp${href}`;

      // 日時テキストを探す
      const timeText = $(el)
        .find("time, .yjSt, .date, span")
        .filter((_, e) =>
          /\d{1,2}:\d{2}|\d{4}-\d{2}|\d{1,2}\/\d{1,2}/.test($(e).text())
        )
        .first()
        .text()
        .trim();
      const ts = parseJpTime(timeText) ?? new Date();
      if (ts < cutoff) return;

      const cleaned = cleanText(title);
      if (isNoise(cleaned)) return;

      posts.push({
        source:    "yahoo",
        username:  "yahoo_finance",
        text:      cleaned,
        timestamp: ts.toISOString(),
        url:       link,
        headline:  cleaned,
      });
    });

    console.log(`[yahoo] ${posts.length} 件取得`);
    return posts.slice(0, MAX_PER_ACCOUNT * 2);
  } catch (err) {
    console.warn(`[yahoo] 取得失敗: ${toErrorMessage(err)}`);
    return [];
  }
}

// ─── キャッシュ ────────────────────────────────────────────────

type YahooTopNewsState = {
  categories?: Array<{
    categoryName?: string;
    articles?: Array<{
      headline?: string;
      link?: string;
      mediaName?: string;
      summary?: string | null;
      createTime?: string;
    }>;
  }>;
};

async function fetchMinkabuNews(): Promise<Post[]> {
  const url = "https://minkabu.jp/news";
  try {
    const { data: html } = await axios.get<string>(url, {
      headers: { "User-Agent": randomUA(), "Accept-Language": "ja-JP,ja;q=0.9" },
      timeout: HTTP_TIMEOUT_MS,
    });
    const $ = cheerio.load(html);
    const posts: Post[] = [];
    const cutoffIso = cutoffTime().toISOString();

    $("#news_list > li").each((_, el) => {
      const item = $(el);
      const titleEl = item.find('.title_box a[href^="/news/"]').first();
      const href = titleEl.attr("href") ?? "";
      const headline = cleanText(item.attr("data-news-name") ?? titleEl.text());
      if (!headline || headline.length < 5 || !href) return;

      const summary = normalizeArticleText(
        item.find(".ly_vamd_inner.vatp, .vatp").first().text()
      );
      const timeText = normalizeArticleText(
        item.find(".flex.items-center.justify-end, .w140p.tar").first().text()
      );
      const timestamp = toIsoOrNull(parseJpTime(timeText));
      if (!timestamp || timestamp < cutoffIso) return;

      const link = href.startsWith("http") ? href : `https://minkabu.jp${href}`;
      const category = cleanText(item.find('a[href*="/news/search?category="]').first().text());
      const text = buildNewsText(headline, summary);
      if (isNoise(text)) return;

      posts.push({
        source: "minkabu",
        username: "minkabu_news",
        text,
        timestamp,
        url: link,
        headline,
        summary: summary || undefined,
        category: category || undefined,
      });
    });

    console.log(`[minkabu] ${posts.length} 件取得`);
    return posts.slice(0, MAX_PER_ACCOUNT * 2);
  } catch (err) {
    console.warn(`[minkabu] 取得失敗: ${toErrorMessage(err)}`);
    return [];
  }
}

function parseYahooPostsFromAppState(html: string, cutoffIso: string): Post[] {
  const jsonText = extractJsonObjectAfterKey(html, "mainNewsTop");
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as YahooTopNewsState;
    const posts: Post[] = [];

    for (const category of parsed.categories ?? []) {
      const categoryName = cleanText(category.categoryName ?? "");
      if (categoryName && !YAHOO_ALLOWED_CATEGORIES.has(categoryName)) continue;
      for (const article of category.articles ?? []) {
        const headline = cleanText(article.headline ?? "");
        const href = article.link ?? "";
        const timestamp = toIsoOrNull(parseJpTime(cleanText(article.createTime ?? "")));
        if (!headline || !href || !timestamp || timestamp < cutoffIso) continue;

        const publisher = cleanText(article.mediaName ?? "");
        const summary = normalizeArticleText(
          typeof article.summary === "string" ? article.summary : ""
        );
        if (!shouldKeepYahooArticle(publisher, headline)) continue;
        const detail = [publisher ? `提供元: ${publisher}` : "", summary]
          .filter(Boolean)
          .join(" / ");
        const text = buildNewsText(headline, detail);
        if (isNoise(text)) continue;

        posts.push({
          source: "yahoo",
          username: "yahoo_finance",
          text,
          timestamp,
          url: href.startsWith("http") ? href : `https://finance.yahoo.co.jp${href}`,
          headline,
          summary: detail || undefined,
          category: categoryName || undefined,
        });
      }
    }

    return dedupePostsByUrl(posts)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, MAX_PER_ACCOUNT * 2);
  } catch {
    return [];
  }
}

function parseYahooPostsFromDom(html: string, cutoffIso: string): Post[] {
  const $ = cheerio.load(html);
  const posts: Post[] = [];

  $(".News_top__14U9").each((_, section) => {
    const category = cleanText($(section).find("h2").first().text());
    if (category && !YAHOO_ALLOWED_CATEGORIES.has(category)) return;

    $(section)
      .find('ul.container__2Ryr > li > a[href*="/news/detail/"]')
      .each((_, anchor) => {
        const linkEl = $(anchor);
        const headline = cleanText(linkEl.find(".title__3ZuA").first().text());
        const href = linkEl.attr("href") ?? "";
        if (!headline || !href) return;

        const metaTexts = linkEl
          .find(".subData__BGDo")
          .map((__, meta) => cleanText($(meta).text()))
          .get()
          .filter(Boolean);
        const timeText = metaTexts.find((text) => isLikelyNewsTime(text)) ?? "";
        const timestamp = toIsoOrNull(parseJpTime(timeText));
        if (!timestamp || timestamp < cutoffIso) return;

        const publisher = metaTexts.find((text) => text !== timeText) ?? "";
        const summaryText = normalizeArticleText(linkEl.find(".summary__2V0H").first().text());
        if (!shouldKeepYahooArticle(publisher, headline)) return;
        const detail = [publisher ? `提供元: ${publisher}` : "", summaryText]
          .filter(Boolean)
          .join(" / ");
        const text = buildNewsText(headline, detail);
        if (isNoise(text)) return;

        posts.push({
          source: "yahoo",
          username: "yahoo_finance",
          text,
          timestamp,
          url: href.startsWith("http") ? href : `https://finance.yahoo.co.jp${href}`,
          headline,
          summary: detail || undefined,
          category: category || undefined,
        });
      });
  });

  return dedupePostsByUrl(posts)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_PER_ACCOUNT * 2);
}

async function fetchYahooFinanceNews(): Promise<Post[]> {
  const url = "https://finance.yahoo.co.jp/news/";
  try {
    const { data: html } = await axios.get<string>(url, {
      headers: { "User-Agent": randomUA(), "Accept-Language": "ja-JP,ja;q=0.9" },
      timeout: HTTP_TIMEOUT_MS,
    });
    const cutoffIso = cutoffTime().toISOString();
    const appStatePosts = parseYahooPostsFromAppState(html, cutoffIso);
    const posts = appStatePosts.length > 0
      ? appStatePosts
      : parseYahooPostsFromDom(html, cutoffIso);

    if (SCRAPER_DEBUG) {
      console.log(
        `[yahoo][debug] parser=${appStatePosts.length > 0 ? "app-state" : "dom-fallback"}`
      );
    }

    console.log(`[yahoo] ${posts.length} 件取得`);
    return posts;
  } catch (err) {
    console.warn(`[yahoo] 取得失敗: ${toErrorMessage(err)}`);
    return [];
  }
}

export async function loadCache(): Promise<Post[]> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as Post[];
  } catch {
    return [];
  }
}

async function saveCache(posts: Post[]): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(posts, null, 2), "utf-8");
  console.log(`[cache] 保存完了: ${posts.length} 件 → ${CACHE_FILE}`);
}

// ─── メインエントリー ──────────────────────────────────────────

export async function fetchAllTweets(
  accounts: AccountConfig[],
  options: FetchOptions = {}
): Promise<Post[]> {
  console.log("[fetcher] 投稿取得開始（x.com Puppeteer + 代替ソース）");

  // 方法1 (x.com) と 方法2 (代替ソース) を並列実行
  const [xPosts, kabutanPosts, minkabuPosts, yahooPosts] = await Promise.all([
    fetchXPosts(accounts, options).catch((err) => {
      console.error(`[x.com] 致命エラー: ${toErrorMessage(err)}`);
      return [] as Post[];
    }),
    fetchKabutan(),
    fetchMinkabuNews(),
    fetchYahooFinanceNews(),
  ]);

  const all = [...xPosts, ...kabutanPosts, ...minkabuPosts, ...yahooPosts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // ソース別サマリ
  const summary: Record<string, number> = {};
  for (const p of all) summary[p.source] = (summary[p.source] ?? 0) + 1;

  console.log(
    `[fetcher] 完了: 合計 ${all.length} 件` +
    ` | ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(", ")}`
  );

  await saveCache(all);
  return all;
}
