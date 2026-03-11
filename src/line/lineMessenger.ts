/**
 * lineMessenger.ts
 * LINE Messaging API ブロードキャスト配信モジュール
 * Flex Message で株クラ AI 分析レポートを全友だちに送信する
 */

import { messagingApi } from "@line/bot-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import type { StockAnalysisResult, StockPick, TrendingTheme } from "../analyzer/stockAnalyzer";

// ─── 型エイリアス ──────────────────────────────────────────────
type Client       = messagingApi.MessagingApiClient;
type Message      = messagingApi.Message;
type FlexMessage  = messagingApi.FlexMessage;
type FlexBubble   = messagingApi.FlexBubble;
type FlexCarousel = messagingApi.FlexCarousel;
type FlexBox      = messagingApi.FlexBox;
type FlexText     = messagingApi.FlexText;
type FlexSeparator = messagingApi.FlexSeparator;

// ─── 定数 ──────────────────────────────────────────────────────
const MAX_RETRIES      = 3;
const BASE_DELAY_MS    = 1_000;
const PICKS_PER_BUBBLE = 3;       // 1バブルあたりの銘柄数
const MAX_ALT_TEXT     = 400;     // LINE の altText 上限
const MAX_TEXT_COMPONENT = 500;
const MAX_SOURCE_ITEMS   = 3;
const LINE_DEBUG_PAYLOAD = process.env.LINE_DEBUG_PAYLOAD === "1";
const LINE_DEBUG_DIR     = path.resolve(__dirname, "../../tmp");

// カラーパレット
const COLOR = {
  headerBg:   "#1D2A40",
  headerText: "#FFFFFF",
  accent:     "#F5A623",
  rankGold:   "#FFD700",
  rankSilver: "#C0C0C0",
  rankBronze: "#CD7F32",
  sectionHd:  "#2E86AB",
  bodyText:   "#333333",
  subText:    "#777777",
  separator:  "#DDDDDD",
  footerBg:   "#F5F5F5",
  sentiBg:    "#EAF4FB",
  disclaimer: "#FF6B35",
} as const;

// ─── LINE クライアント（遅延初期化）────────────────────────────
let _client: Client | null = null;

function getClient(): Client {
  if (!_client) {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
    if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です");
    _client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
  }
  return _client;
}

// ─── ユーティリティ ────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getTimeSlot(date: Date): string {
  const h = date.getHours();
  if (h >= 5  && h < 12) return "朝の部";
  if (h >= 12 && h < 17) return "昼の部";
  if (h >= 17 && h < 23) return "夜の部";
  return "深夜の部";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

/** 確度スコアを ⭐ 表示に変換 (10段階 → ⭐×10) */
function starRating(confidence: number): string {
  const filled = Math.round(Math.min(10, Math.max(0, confidence)));
  const empty  = 10 - filled;
  return "⭐".repeat(filled) + "☆".repeat(empty) + ` (${confidence}/10)`;
}

/** 順位に応じたメダル絵文字 */
function medalEmoji(rank: number): string {
  return ["🥇", "🥈", "🥉"][rank - 1] ?? `${rank}位`;
}

/** 順位に応じたテキスト色 */
function rankColor(rank: number): string {
  return [COLOR.rankGold, COLOR.rankSilver, COLOR.rankBronze][rank - 1] ?? COLOR.bodyText;
}

function clipText(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatShortTimestamp(timestamp?: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getUrlHost(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getBackdropThemes(result: StockAnalysisResult): TrendingTheme[] {
  return result.market_backdrop ?? [];
}

function getInvestableThemes(result: StockAnalysisResult): TrendingTheme[] {
  return result.investable_themes ?? result.trending_themes;
}

function getAssociativePicks(result: StockAnalysisResult): StockPick[] {
  return result.associative_picks ?? result.stock_picks;
}

function getDirectPicks(result: StockAnalysisResult): StockPick[] {
  return result.direct_picks ?? [];
}

function getNextGuidance(result: StockAnalysisResult) {
  return result.next_check_guidance ?? [];
}

function getSectorWatch(result: StockAnalysisResult) {
  return result.sector_watch ?? [];
}

function getProcessWatch(result: StockAnalysisResult) {
  return result.process_watch ?? [];
}

function getGuidanceForTheme(result: StockAnalysisResult, themeName: string) {
  return getNextGuidance(result)
    .find((item) => item.theme === themeName);
}

function describeSourceRole(role?: "backdrop" | "investable" | "sector_watch" | "process_watch"): string {
  if (role === "investable") return "投資テーマ";
  if (role === "sector_watch") return "業種監視";
  if (role === "process_watch") return "工程監視";
  if (role === "backdrop") return "背景";
  return "";
}

function describePickType(pick: StockPick, section: "associative" | "watch" | "direct"): string | undefined {
  if (section === "direct") return "直接材料";
  if (section === "associative") return "桶屋本命";
  switch (pick.benefit_type) {
    case "origin":
      return "当事者監視";
    case "primary":
      return "一次受益監視";
    case "peripheral":
      return "周辺工程監視";
    default:
      return undefined;
  }
}

// ─── Flex Message ブロックビルダー ─────────────────────────────

function sep(): FlexSeparator {
  return { type: "separator", color: COLOR.separator, margin: "md" };
}

function txt(
  text: string,
  opts: Partial<FlexText> = {}
): FlexText {
  const normalized = text.length > MAX_TEXT_COMPONENT
    ? `${text.slice(0, MAX_TEXT_COMPONENT - 1)}…`
    : text;
  return {
    type: "text",
    text: normalized || "\u200B",
    wrap: true,
    ...opts,
  } as FlexText;
}

/** ヘッダーボックス */
function buildHeader(date: Date): FlexBox {
  return {
    type:            "box",
    layout:          "vertical",
    backgroundColor: COLOR.headerBg,
    paddingAll:      "16px",
    contents: [
      txt("📊 株クラ AI 分析レポート", {
        weight: "bold", size: "lg", color: COLOR.headerText,
      }),
      txt(`📅 ${formatDate(date)} ${getTimeSlot(date)}`, {
        size: "sm", color: "#AABBCC", margin: "sm",
      }),
    ],
  } as FlexBox;
}

/** トレンドテーマセクション */
function buildThemesSection(themes: TrendingTheme[]): FlexBox[] {
  if (themes.length === 0) {
    return [
      {
        type: "box", layout: "vertical", margin: "lg",
        contents: [
          txt("今日の投資テーマ", { weight: "bold", size: "md", color: COLOR.sectionHd }),
          txt("今日は背景相場中心で、投資テーマは見送り。", {
            size: "xs", color: COLOR.bodyText, margin: "sm",
          }),
        ],
      } as FlexBox,
    ];
  }
  const enhancedBlocks: FlexBox[] = [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("今日の主要テーマ", { weight: "bold", size: "md", color: COLOR.sectionHd }),
      ],
    } as FlexBox,
  ];

  for (const [index, theme] of themes.slice(0, 3).entries()) {
    const primaryNews = (theme.news_items ?? [])[0];
    const themeContents: Array<FlexBox | FlexText> = [
      txt(`${index + 1}. ${theme.theme}`, {
        size: "sm", weight: "bold", color: COLOR.bodyText,
      }),
      txt(`言及 ${theme.mention_count}件`, {
        size: "xs", color: COLOR.subText, margin: "xs",
      }),
    ];

    if (primaryNews) {
      const meta = [primaryNews.source, formatShortTimestamp(primaryNews.timestamp), getUrlHost(primaryNews.url)]
        .filter(Boolean)
        .join(" / ");
      themeContents.push({
        type: "box", layout: "vertical", margin: "sm",
        backgroundColor: "#F7FAFC",
        cornerRadius: "6px",
        paddingAll: "6px",
        contents: [
          txt(`起点ニュース: ${clipText(primaryNews.headline, 78)}`, {
            size: "xs", weight: "bold", color: COLOR.bodyText,
          }),
          ...(primaryNews.summary ? [txt(`何が起きたか: ${clipText(primaryNews.summary, 84)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })] : []),
          ...(theme.why_it_matters ? [txt(`なぜ重要か: ${clipText(theme.why_it_matters, 84)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })] : []),
          ...((theme.beneficiary_processes ?? []).length > 0 ? [txt(
            `どこに効くか: ${clipText((theme.beneficiary_processes ?? []).join(" -> "), 84)}`,
            { size: "xs", color: COLOR.bodyText, margin: "xs" }
          )] : []),
          ...(meta ? [txt(meta, {
            size: "xxs", color: COLOR.subText, margin: "xs",
          })] : []),
        ],
      } as FlexBox);
    } else if (theme.why_it_matters) {
      themeContents.push(
        txt(`なぜ重要か: ${clipText(theme.why_it_matters, 96)}`, {
          size: "xs", color: COLOR.bodyText, margin: "sm",
        })
      );
      if ((theme.beneficiary_processes ?? []).length > 0) {
        themeContents.push(
          txt(`どこに効くか: ${clipText((theme.beneficiary_processes ?? []).join(" -> "), 92)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })
        );
      }
    }

    enhancedBlocks.push({
      type: "box", layout: "vertical", margin: "md",
      contents: themeContents,
    } as FlexBox);
  }

  return enhancedBlocks;

  const blocks: FlexBox[] = [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("🔥 注目テーマ", { weight: "bold", size: "md", color: COLOR.sectionHd }),
      ],
    } as FlexBox,
  ];

  const topThemes = themes.slice(0, 5);
  for (const [i, theme] of topThemes.entries()) {
    blocks.push({
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        txt(`${i + 1}.`, {
          size: "sm", flex: 0, color: COLOR.accent, weight: "bold",
        }),
        {
          type: "box", layout: "vertical", flex: 1, margin: "sm",
          contents: [
            txt(theme.theme, { size: "sm", weight: "bold", color: COLOR.bodyText }),
            txt(`言及数: ${theme.mention_count} 件`, {
              size: "xs", color: COLOR.subText,
            }),
          ],
        } as FlexBox,
      ],
    } as FlexBox);
  }

  return blocks;
}

/** 1銘柄分のボックス */
function buildPickBox(
  pick: StockPick,
  section: "associative" | "watch" | "direct" = "associative"
): FlexBox {
  const rankEmoji = medalEmoji(pick.rank);
  const rankClr   = rankColor(pick.rank);
  const pickType  = describePickType(pick, section);

  return {
    type: "box", layout: "vertical", margin: "lg",
    backgroundColor: pick.rank === 1 ? "#FFFBF0" : undefined,
    cornerRadius: "8px",
    paddingAll: pick.rank === 1 ? "8px" : "0px",
    contents: [
      {
        type: "box", layout: "horizontal", alignItems: "center",
        contents: [
          txt(rankEmoji, { size: "lg", flex: 0 }),
          {
            type: "box", layout: "vertical", flex: 1, margin: "sm",
            contents: [
              txt(`${pick.name}(${pick.code})`, {
                weight: "bold", size: "md", color: rankClr,
              }),
              ...(pickType ? [txt(pickType, {
                size: "xs", color: COLOR.sectionHd, margin: "xs",
              })] : []),
              txt(starRating(pick.confidence), {
                size: "xs", color: COLOR.subText, margin: "xs",
              }),
            ],
          } as FlexBox,
        ],
      } as FlexBox,
      {
        type: "box", layout: "vertical", margin: "sm",
        backgroundColor: "#F0F8FF",
        cornerRadius: "4px",
        paddingAll: "6px",
        contents: [
          txt("受益構造", { size: "xs", color: COLOR.sectionHd, weight: "bold" }),
          txt(clipText(pick.chain, 104), { size: "xs", color: COLOR.bodyText, margin: "xs" }),
        ],
      } as FlexBox,
      ...(pick.root_theme ? [{
        type: "box", layout: "horizontal", margin: "xs",
        contents: [
          txt("乗るテーマ", { size: "xs", flex: 2, color: COLOR.subText }),
          txt(clipText(pick.root_theme, 70), { size: "xs", flex: 5, color: COLOR.bodyText }),
        ],
      } as FlexBox] : []),
      ...((pick.supporting_news ?? []).slice(0, 1).map((news, index): FlexBox => ({
        type: "box", layout: "horizontal", margin: "xs",
        contents: [
          txt(index === 0 ? "起点ニュース" : "", { size: "xs", flex: 2, color: COLOR.subText }),
          txt(clipText(news, 76), { size: "xs", flex: 5, color: COLOR.bodyText }),
        ],
      } as FlexBox))),
      ...(
        [
          ["受益理由", pick.reasoning],
          ["注目点", pick.catalyst],
          ["リスク", pick.risk],
        ] as [string, string][]
      ).map(([label, value]): FlexBox => ({
        type: "box", layout: "horizontal", margin: "xs",
        contents: [
          txt(label, { size: "xs", flex: 2, color: COLOR.subText }),
          txt(clipText(value, 76), { size: "xs", flex: 5, color: COLOR.bodyText }),
        ],
      } as FlexBox)),
    ],
  } as FlexBox;

  return {
    type: "box", layout: "vertical", margin: "lg",
    backgroundColor: pick.rank === 1 ? "#FFFBF0" : undefined,
    cornerRadius:    "8px",
    paddingAll:      pick.rank === 1 ? "8px" : "0px",
    contents: [
      // 銘柄名・コード
      {
        type: "box", layout: "horizontal", alignItems: "center",
        contents: [
          txt(rankEmoji, { size: "lg", flex: 0 }),
          {
            type: "box", layout: "vertical", flex: 1, margin: "sm",
            contents: [
              txt(`${pick.name}（${pick.code}）`, {
                weight: "bold", size: "md", color: rankClr,
              }),
              txt(starRating(pick.confidence), {
                size: "xs", color: COLOR.subText, margin: "xs",
              }),
            ],
          } as FlexBox,
        ],
      } as FlexBox,
      // 連想チェーン
      {
        type: "box", layout: "vertical", margin: "sm",
        backgroundColor: "#F0F8FF",
        cornerRadius: "4px",
        paddingAll: "6px",
        contents: [
          txt("🔗 連想経路", { size: "xs", color: COLOR.sectionHd, weight: "bold" }),
          txt(pick.chain, { size: "xs", color: COLOR.bodyText, margin: "xs" }),
        ],
      } as FlexBox,
      // 理由・リスク・カタリスト
      ...(
        [
          ["💡 理由",     pick.reasoning ],
          ["⚡ カタリスト", pick.catalyst ],
          ["⚠️ リスク",   pick.risk      ],
        ] as [string, string][]
      ).map(([label, value]): FlexBox => ({
        type: "box", layout: "horizontal", margin: "xs",
        contents: [
          txt(label, { size: "xs", flex: 2, color: COLOR.subText }),
          txt(value, { size: "xs", flex: 5, color: COLOR.bodyText }),
        ],
      } as FlexBox)),
    ],
  } as FlexBox;
}

/** 市場センチメントセクション */
function buildSentimentSection(sentiment: string): FlexBox {
  return {
    type: "box", layout: "vertical", margin: "lg",
    backgroundColor: COLOR.sentiBg,
    cornerRadius: "8px",
    paddingAll: "10px",
    contents: [
      txt("📈 市場センチメント", {
        weight: "bold", size: "sm", color: COLOR.sectionHd,
      }),
      txt(clipText(sentiment, 220), { size: "sm", color: COLOR.bodyText, margin: "sm" }),
    ],
  } as FlexBox;
}

function buildSourceSection(result: StockAnalysisResult): FlexBox[] {
  if ((result.source_list ?? []).length === 0) return [];

  const blocks: FlexBox[] = [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("ソース一覧", { weight: "bold", size: "md", color: COLOR.sectionHd }),
      ],
    } as FlexBox,
  ];

  for (const source of (result.source_list ?? []).slice(0, MAX_SOURCE_ITEMS)) {
    const meta = [describeSourceRole(source.role), source.source, formatShortTimestamp(source.timestamp), getUrlHost(source.url)]
      .filter(Boolean)
      .join(" / ");
    blocks.push({
      type: "box", layout: "vertical", margin: "sm",
      contents: [
        txt(clipText(source.headline, 90), {
          size: "xs", weight: "bold", color: COLOR.bodyText,
        }),
        ...(meta ? [txt(meta, { size: "xxs", color: COLOR.subText, margin: "xs" })] : []),
      ],
    } as FlexBox);
  }

  return blocks;
}

function buildBackdropSection(result: StockAnalysisResult): FlexBox[] {
  const themes = getBackdropThemes(result).slice(0, getInvestableThemes(result).length > 0 ? 1 : 2);
  if (themes.length === 0) return [];

  return [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("Market Backdrop", { weight: "bold", size: "sm", color: COLOR.sectionHd }),
        ...themes.map((theme) => {
          const guidance = getGuidanceForTheme(result, theme.theme);
          const focus = [
            guidance?.sectors?.slice(0, 2).join("・"),
            guidance?.processes?.[0],
          ].filter(Boolean).join(" / ");
          return txt(
            `${clipText(theme.theme, 20)}${focus ? `: ${clipText(focus, 30)}` : theme.why_it_matters ? `: ${clipText(theme.why_it_matters, 24)}` : ""}`,
            { size: "xs", color: COLOR.bodyText, margin: "xs" }
          );
        }),
      ],
    } as FlexBox,
  ];
}

function buildDirectPickSection(result: StockAnalysisResult): FlexBox[] {
  const picks = getDirectPicks(result).slice(0, 2);
  if (picks.length === 0) return [];

  return [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("Direct Picks", { weight: "bold", size: "md", color: COLOR.sectionHd }),
      ],
    } as FlexBox,
    ...picks.map((pick) => ({
      type: "box",
      layout: "vertical",
      margin: "sm",
      backgroundColor: "#F7FAFC",
      cornerRadius: "8px",
      paddingAll: "8px",
      contents: [
        txt(`${pick.name}(${pick.code})`, { size: "sm", weight: "bold", color: COLOR.bodyText }),
        ...(pick.root_theme ? [txt(`テーマ: ${clipText(pick.root_theme, 44)}`, {
          size: "xs", color: COLOR.subText, margin: "xs",
        })] : []),
        txt(`材料: ${clipText(pick.reasoning, 78)}`, {
          size: "xs", color: COLOR.bodyText, margin: "xs",
        }),
      ],
    } as FlexBox)),
  ];
}

function buildWatchChecklist(result: StockAnalysisResult): string[] {
  const explicitChecks = (result.next_checks ?? []).slice(0, 3);
  if (explicitChecks.length > 0) return explicitChecks;
  const watchChecks = (result.watch_candidates ?? [])
    .map((pick) => `${pick.name}: ${clipText(pick.catalyst.replace(/^次に確認:\s*/, ""), 46)}`)
    .slice(0, 2);

  if (watchChecks.length > 0) return watchChecks;

  return getInvestableThemes(result)
    .slice(0, 2)
    .map((theme) => {
      const process = (theme.beneficiary_processes ?? [])[0];
      const news = theme.news_items?.[0]?.headline;
      return news
        ? `${theme.theme}: ${clipText(process ?? news, 44)}`
        : `${theme.theme}: ${clipText(process ?? "続報と具体企業名の確認", 44)}`;
    });
}

function buildNoPickSection(result: StockAnalysisResult): FlexBox[] {
  const checks = buildWatchChecklist(result);
  const watchPicks = (result.watch_candidates ?? []).slice(0, 2);
  const directPicks = getDirectPicks(result).slice(0, 2);
  const sectorWatch = getSectorWatch(result).slice(0, 2);
  const processWatch = getProcessWatch(result).slice(0, 2);

  return [
    {
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        txt("本命候補", { weight: "bold", size: "md", color: COLOR.sectionHd }),
      ],
    } as FlexBox,
    {
      type: "box", layout: "vertical", margin: "sm",
      backgroundColor: "#FFF7E8",
      cornerRadius: "8px",
      paddingAll: "10px",
      contents: [
        txt("本命 0件", { size: "sm", weight: "bold", color: COLOR.bodyText }),
        txt("弱い根拠で無理に補完せず、注視テーマと監視候補のみ表示しています。", {
          size: "xs", color: COLOR.bodyText, margin: "xs",
        }),
      ],
    } as FlexBox,
    ...(!watchPicks.length ? [{
      type: "box", layout: "vertical", margin: "sm",
      backgroundColor: "#F7FAFC",
      cornerRadius: "8px",
      paddingAll: "10px",
      contents: [
        txt("監視 0件", { size: "sm", weight: "bold", color: COLOR.bodyText }),
        txt("まだ工程の裏付けが弱く、監視候補への昇格も見送り。", {
          size: "xs", color: COLOR.bodyText, margin: "xs",
        }),
      ],
    } as FlexBox] : []),
    ...(watchPicks.length > 0 ? [
      {
        type: "box", layout: "vertical", margin: "md",
        contents: [
          txt("監視候補（低確度）", { weight: "bold", size: "sm", color: COLOR.sectionHd }),
        ],
      } as FlexBox,
      ...watchPicks.flatMap((pick, index) => [
        buildPickBox(pick, "watch"),
        ...(index < watchPicks.length - 1 ? [sep() as unknown as FlexBox] : []),
      ]),
    ] : []),
    ...(directPicks.length > 0 ? buildDirectPickSection(result) : []),
    ...(sectorWatch.length > 0 ? [
      {
        type: "box", layout: "vertical", margin: "md",
        contents: [
          txt("Sector Watch", { weight: "bold", size: "sm", color: COLOR.sectionHd }),
        ],
      } as FlexBox,
      ...sectorWatch.map((item) => ({
        type: "box", layout: "vertical", margin: "sm",
        backgroundColor: "#F7FAFC",
        cornerRadius: "8px",
        paddingAll: "10px",
        contents: [
          txt(item.sector, { weight: "bold", size: "sm", color: COLOR.bodyText }),
          txt(`注視テーマ: ${clipText(item.theme, 76)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          }),
          txt(`昇格条件: ${clipText(item.promotion_conditions.join(" / "), 78)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          }),
        ],
      } as FlexBox)),
    ] : []),
    ...(processWatch.length > 0 ? [
      {
        type: "box", layout: "vertical", margin: "md",
        contents: [
          txt("Process Watch", { weight: "bold", size: "sm", color: COLOR.sectionHd }),
        ],
      } as FlexBox,
      ...processWatch.map((item) => ({
        type: "box", layout: "vertical", margin: "sm",
        backgroundColor: "#F7FAFC",
        cornerRadius: "8px",
        paddingAll: "10px",
        contents: [
          txt(item.process, { weight: "bold", size: "sm", color: COLOR.bodyText }),
          txt(`波及確認: ${clipText(item.focus, 76)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          }),
          txt(`昇格条件: ${clipText(item.promotion_conditions.join(" / "), 78)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          }),
        ],
      } as FlexBox)),
    ] : []),
    ...((sectorWatch.length === 0 && processWatch.length === 0) ? getNextGuidance(result).slice(0, 2).flatMap((item) => ([
      {
        type: "box", layout: "vertical", margin: "md",
        backgroundColor: "#F7FAFC",
        cornerRadius: "8px",
        paddingAll: "10px",
        contents: [
          txt(item.theme, { weight: "bold", size: "sm", color: COLOR.bodyText }),
          ...(item.sectors.length > 0 ? [txt(`注視業種: ${clipText(item.sectors.join(" / "), 78)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })] : []),
          ...(item.processes.length > 0 ? [txt(`注視工程: ${clipText(item.processes.join(" / "), 78)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })] : []),
          ...(item.triggers.length > 0 ? [txt(`昇格条件: ${clipText(item.triggers.join(" / "), 78)}`, {
            size: "xs", color: COLOR.bodyText, margin: "xs",
          })] : []),
        ],
      } as FlexBox,
    ])) : []),
    {
      type: "box", layout: "vertical", margin: "md",
      backgroundColor: "#F7FAFC",
      cornerRadius: "8px",
      paddingAll: "10px",
      contents: [
        txt("次に確認", { weight: "bold", size: "sm", color: COLOR.sectionHd }),
        ...checks.map((item) => txt(`・${item}`, {
          size: "xs", color: COLOR.bodyText, margin: "xs",
        })),
      ],
    } as FlexBox,
  ];
}

/** フッター免責事項 */
async function saveLinePayload(
  messages: Message[],
  label: string
): Promise<void> {
  await fs.mkdir(LINE_DEBUG_DIR, { recursive: true });
  const filePath = path.join(LINE_DEBUG_DIR, `line-payload-${label}.json`);
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8");
  console.log(`[line][debug] payload saved: ${filePath}`);
}

function buildFooter(): FlexBox {
  return {
    type: "box", layout: "vertical",
    backgroundColor: COLOR.footerBg,
    paddingAll: "12px",
    contents: [
      {
        type: "box", layout: "horizontal", alignItems: "center",
        contents: [
          txt("━".repeat(20), { size: "xxs", color: COLOR.separator }),
        ],
      } as FlexBox,
      txt(
        "⚠️ 本レポートは AI 分析による参考情報です。\n投資判断は自己責任でお願いします。",
        { size: "xs", color: COLOR.disclaimer, margin: "sm", wrap: true }
      ),
    ],
  } as FlexBox;
}

// ─── バブル組み立て ────────────────────────────────────────────

/**
 * 分析結果全体を 1〜複数の FlexBubble に分割して構築する
 * 銘柄数が PICKS_PER_BUBBLE を超えたら追加バブルへ
 */
function buildBubbles(result: StockAnalysisResult): FlexBubble[] {
  const now    = new Date();
  const bubbles: FlexBubble[] = [];

  // ── バブル 1: テーマ + 上位 3 銘柄 + センチメント ───────────
  const associativePicks = getAssociativePicks(result);
  const mainPicks   = associativePicks.slice(0, PICKS_PER_BUBBLE);
  const extraPicks  = associativePicks.slice(PICKS_PER_BUBBLE);
  const pickSection = mainPicks.length > 0
    ? [
      {
        type: "box", layout: "vertical", margin: "lg",
        contents: [
          txt("💎 風が吹けば桶屋が儲かる銘柄 TOP3", {
            weight: "bold", size: "md", color: COLOR.sectionHd,
          }),
        ],
      } as FlexBox,
      ...mainPicks.flatMap((pick) => [
        buildPickBox(pick, "associative"),
        ...(pick.rank < mainPicks.length ? [sep() as unknown as FlexBox] : []),
      ]),
    ]
    : buildNoPickSection(result);

  const mainBodyContents: FlexBox[] = [
    ...buildBackdropSection(result),
    ...(getBackdropThemes(result).length > 0 ? [sep() as unknown as FlexBox] : []),
    ...buildThemesSection(getInvestableThemes(result)),
    ...(getDirectPicks(result).length > 0 ? [sep() as unknown as FlexBox, ...buildDirectPickSection(result)] : []),
    sep() as unknown as FlexBox,
    ...pickSection,
    sep() as unknown as FlexBox,
    buildSentimentSection(result.market_sentiment),
    ...(result.source_list && result.source_list.length > 0
      ? [sep() as unknown as FlexBox, ...buildSourceSection(result)]
      : []),
  ];

  bubbles.push({
    type:   "bubble",
    size:   "giga",
    header: buildHeader(now),
    body:   {
      type:     "box",
      layout:   "vertical",
      paddingAll: "14px",
      contents: mainBodyContents,
    } as FlexBox,
    footer: buildFooter(),
  } as FlexBubble);

  // ── バブル 2+: 残りの銘柄 ──────────────────────────────────
  if (extraPicks.length > 0) {
    const extraBodyContents: FlexBox[] = [
      {
        type: "box",
        layout: "vertical",
        contents: [txt("💎 追加注目銘柄", { weight: "bold", size: "md", color: COLOR.sectionHd })],
      } as FlexBox,
      ...extraPicks.flatMap((pick, i) => [
        buildPickBox(pick, "associative"),
        ...(i < extraPicks.length - 1 ? [sep() as unknown as FlexBox] : []),
      ]),
    ];

    bubbles.push({
      type:   "bubble",
      size:   "giga",
      header: {
        type:            "box",
        layout:          "vertical",
        backgroundColor: COLOR.headerBg,
        paddingAll:      "12px",
        contents: [
          txt("📊 株クラ AI 分析レポート（続き）", {
            weight: "bold", size: "md", color: COLOR.headerText,
          }),
        ],
      } as FlexBox,
      body: {
        type:     "box",
        layout:   "vertical",
        paddingAll: "14px",
        contents: extraBodyContents,
      } as FlexBox,
      footer: buildFooter(),
    } as FlexBubble);
  }

  return bubbles;
}

/** altText 用のプレーンテキストサマリーを生成 */
function buildAltText(result: StockAnalysisResult): string {
  const slot   = getTimeSlot(new Date());
  const themes = result.trending_themes.slice(0, 2).map((t) => t.theme).join("・");
  const pick1  = result.stock_picks[0];
  const watch1 = result.watch_candidates?.[0];
  const pickStr = pick1
    ? `注目: ${pick1.name}（${pick1.code}）確度${pick1.confidence}/10`
    : watch1
      ? `本命0件 / 監視: ${watch1.name}（${watch1.code}）`
      : "本命0件 / 注視テーマ中心";

  const raw = `📊 ${slot} 株クラ分析 | テーマ: ${themes} | ${pickStr}`;
  return raw.length > MAX_ALT_TEXT ? raw.slice(0, MAX_ALT_TEXT - 1) + "…" : raw;
}

/**
 * 分析結果を LINE Flex Message に変換する（必要に応じてカルーセルに分割）
 */
function buildFlexMessages(result: StockAnalysisResult): FlexMessage[] {
  const bubbles = buildBubbles(result);
  const altText = buildAltText(result);

  if (bubbles.length === 1) {
    return [{
      type:     "flex",
      altText,
      contents: bubbles[0],
    }];
  }

  // 複数バブルはカルーセルにまとめる
  return [{
    type:     "flex",
    altText,
    contents: {
      type:     "carousel",
      contents: bubbles,
    } as FlexCarousel,
  }];
}

// ─── 送信ロジック ──────────────────────────────────────────────

/**
 * ブロードキャスト送信（exponential backoff リトライ付き）
 */
async function broadcastWithRetry(
  messages: Message[],
  attempt = 1
): Promise<void> {
  try {
    await getClient().broadcast({ messages });
    console.log(
      `[line] ブロードキャスト送信成功: ${messages.length} メッセージ`
    );
  } catch (err) {
    await saveLinePayload(
      messages,
      attempt >= MAX_RETRIES ? "error-final" : `error-${attempt}`
    );
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[line] 送信失敗（試行 ${attempt}/${MAX_RETRIES}）: ${errMsg}`
    );

    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `[line] ブロードキャスト送信が ${MAX_RETRIES} 回失敗しました: ${errMsg}`
      );
    }

    const delay = BASE_DELAY_MS * 2 ** (attempt - 1); // 1s → 2s → 4s
    console.log(`[line] ${delay}ms 後にリトライします...`);
    await sleep(delay);
    await broadcastWithRetry(messages, attempt + 1);
  }
}

// ─── 送信ログ ──────────────────────────────────────────────────
function logSend(result: StockAnalysisResult, success: boolean, error?: string): void {
  const ts      = new Date().toISOString();
  const themes  = result.trending_themes.map((t) => t.theme).join(", ");
  const topPick = result.stock_picks[0];
  const status  = success ? "SUCCESS" : "FAILED";

  console.log(
    `[line][${status}] ${ts} | ` +
    `テーマ: ${themes || "なし"} | ` +
    `TOP銘柄: ${topPick ? `${topPick.name}(${topPick.code}) conf=${topPick.confidence}` : "なし"}` +
    (error ? ` | エラー: ${error}` : "")
  );
}

// ─── 公開 API ──────────────────────────────────────────────────

/**
 * 分析結果を Flex Message でブロードキャスト配信する
 */
export async function broadcastAnalysis(result: StockAnalysisResult): Promise<void> {
  try {
    const messages = buildFlexMessages(result) as Message[];
    if (LINE_DEBUG_PAYLOAD) {
      await saveLinePayload(messages, "preview");
    }
    console.log(
      `[line] 送信準備完了: ${messages.length} メッセージ / ` +
      `銘柄 ${result.stock_picks.length} 件 / テーマ ${result.trending_themes.length} 件`
    );

    await broadcastWithRetry(messages);
    logSend(result, true);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logSend(result, false, errMsg);
    throw err;
  }
}

/**
 * プレーンテキストをブロードキャスト配信する（エラー通知・システム通知用）
 */
export async function broadcastText(text: string): Promise<void> {
  const truncated = text.length > 5000 ? text.slice(0, 4997) + "…" : text;
  await broadcastWithRetry([{ type: "text", text: truncated }]);
  console.log(`[line] テキスト送信成功: ${truncated.length} 文字`);
}

/**
 * 送信前に Flex Message のプレビューを文字列で確認する（デバッグ用）
 */
export function previewMessage(result: StockAnalysisResult): string {
  const messages = buildFlexMessages(result);
  return JSON.stringify(messages, null, 2);
}
