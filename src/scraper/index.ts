import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";

export interface Post {
  id: string;
  author: string;
  content: string;
  url: string;
  publishedAt: Date;
  source: "nitter" | "rss" | "rss-bridge";
}

const rssParser = new Parser();

const HOURS_LOOKBACK = 12;
const MAX_ITEMS_PER_FEED = 20;

/** 過去 HOURS_LOOKBACK 時間のカットオフ時刻を返す */
function cutoffTime(): Date {
  return new Date(Date.now() - HOURS_LOOKBACK * 60 * 60 * 1000);
}

/**
 * HTMLタグ・URL・RT接頭辞・画像リンクを除去して純粋なテキストにする
 */
function cleanContent(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")          // HTMLタグ除去
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, " ")
    .replace(/https?:\/\/\S+/g, "")    // URL除去
    .replace(/pic\.twitter\.com\/\S+/g, "") // 画像リンク除去
    .replace(/^RT\s+@\w+:\s*/i, "")    // RT接頭辞除去
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * システムエラー系・空テキスト等のノイズ投稿かどうか判定する
 */
function isNoise(text: string): boolean {
  if (!text || text.length < 10) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("error") ||
    lower.includes("取得できません") ||
    lower.includes("not found") ||
    lower.includes("service unavailable") ||
    lower.includes("503") ||
    lower.includes("429 too many") ||
    /^[\s\W]*$/.test(text)
  );
}

/**
 * Nitter 経由で X（Twitter）投稿を取得
 * 過去 12 時間・最大 20 件に絞り込み、コンテンツをクリーニングする
 */
export async function scrapeNitter(
  username: string,
  nitterInstance: string
): Promise<Post[]> {
  const url = `${nitterInstance}/${username}/rss`;
  const cutoff = cutoffTime();
  try {
    const feed = await rssParser.parseURL(url);
    return (feed.items ?? [])
      .filter((item) => {
        const d = item.pubDate ? new Date(item.pubDate) : null;
        return d !== null && d >= cutoff;
      })
      .slice(0, MAX_ITEMS_PER_FEED)
      .map((item) => ({
        id: item.guid ?? item.link ?? "",
        author: username,
        content: cleanContent(item.contentSnippet ?? item.content ?? ""),
        url: item.link ?? "",
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        source: "nitter" as const,
      }))
      .filter((post) => !isNoise(post.content));
  } catch (err) {
    console.error(`[scraper] Nitter fetch failed (${username}):`, err);
    return [];
  }
}

/**
 * RSS Bridge 経由でフィードを取得
 * limit パラメータで最大件数を指定し、過去 12 時間に絞り込む
 */
export async function scrapeRssBridge(
  feedUrl: string,
  rssBridgeUrl: string
): Promise<Post[]> {
  const bridgeUrl =
    `${rssBridgeUrl}/?action=display&bridge=FeedMergeBridge&format=Atom` +
    `&url=${encodeURIComponent(feedUrl)}&limit=${MAX_ITEMS_PER_FEED}`;
  const cutoff = cutoffTime();
  try {
    const feed = await rssParser.parseURL(bridgeUrl);
    return (feed.items ?? [])
      .filter((item) => {
        const d = item.pubDate ? new Date(item.pubDate) : null;
        return d !== null && d >= cutoff;
      })
      .slice(0, MAX_ITEMS_PER_FEED)
      .map((item) => ({
        id: item.guid ?? item.link ?? "",
        author: feed.title ?? "unknown",
        content: cleanContent(item.contentSnippet ?? item.content ?? ""),
        url: item.link ?? "",
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        source: "rss-bridge" as const,
      }))
      .filter((post) => !isNoise(post.content));
  } catch (err) {
    console.error(`[scraper] RSS Bridge fetch failed:`, err);
    return [];
  }
}

/**
 * 通常の RSS フィードを取得
 * 過去 12 時間・最大 20 件に絞り込む
 */
export async function scrapeRss(feedUrl: string): Promise<Post[]> {
  const cutoff = cutoffTime();
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return (feed.items ?? [])
      .filter((item) => {
        const d = item.pubDate ? new Date(item.pubDate) : null;
        return d !== null && d >= cutoff;
      })
      .slice(0, MAX_ITEMS_PER_FEED)
      .map((item) => ({
        id: item.guid ?? item.link ?? "",
        author: feed.title ?? "unknown",
        content: cleanContent(item.contentSnippet ?? item.content ?? ""),
        url: item.link ?? "",
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        source: "rss" as const,
      }))
      .filter((post) => !isNoise(post.content));
  } catch (err) {
    console.error(`[scraper] RSS fetch failed (${feedUrl}):`, err);
    return [];
  }
}
