// @ts-nocheck
/**
 * stockAnalyzer.ts
 * OpenAI API を使って X 投稿を「風が吹けば桶屋が儲かる」視点で分析し
 * 次に注目が集まりそうな隠れ恩恵銘柄を発掘する
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Post as Tweet } from "../scraper/tweetFetcher";

// ─── 型定義 ────────────────────────────────────────────────────
export interface TrendingTheme {
  theme:         string;
  mention_count: number;
  key_tweets:    string[];
  why_it_matters?: string;
  news_items?: ThemeNewsItem[];
  beneficiary_processes?: string[];
}

export interface ThemeNewsItem {
  headline: string;
  summary: string;
  source: "x" | "kabutan" | "minkabu" | "yahoo";
  url?: string;
  timestamp?: string;
  importance?: number;
}

export interface StockPick {
  rank:       number;
  code:       string;
  name:       string;
  chain:      string;
  reasoning:  string;
  confidence: number;
  risk:       string;
  catalyst:   string;
  root_theme?: string;
  supporting_news?: string[];
  benefit_type?: "origin" | "primary" | "peripheral";
}

export interface SourceReference {
  source: "x" | "kabutan" | "minkabu" | "yahoo";
  headline: string;
  url?: string;
  timestamp?: string;
  role?: "backdrop" | "investable" | "sector_watch" | "process_watch";
  theme?: string;
}

export interface NextCheckGuidance {
  theme: string;
  role: "backdrop" | "investable";
  sectors: string[];
  processes: string[];
  triggers: string[];
}

export interface SectorWatchItem {
  theme: string;
  sector: string;
  why: string;
  promotion_conditions: string[];
}

export interface ProcessWatchItem {
  theme: string;
  process: string;
  focus: string;
  promotion_conditions: string[];
}

export interface StockAnalysisResult {
  analysis_date:    string;
  trending_themes:  TrendingTheme[];
  stock_picks:      StockPick[];
  watch_candidates?: StockPick[];
  market_backdrop?: TrendingTheme[];
  investable_themes?: TrendingTheme[];
  direct_picks?: StockPick[];
  associative_picks?: StockPick[];
  sector_watch?: SectorWatchItem[];
  process_watch?: ProcessWatchItem[];
  next_checks?: string[];
  next_check_guidance?: NextCheckGuidance[];
  market_sentiment: string;
  source_list?:     SourceReference[];
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface XAccountWeightSummary {
  username: string;
  totalPosts: number;
  marketRelevantPosts: number;
  highSignalPosts: number;
  lowSignalPosts: number;
  linkPosts: number;
  structuredPosts: number;
  earlyClusterMentions: number;
  averageSignal: number;
  weight: number;
}

interface XHypothesisCluster {
  key: string;
  label: string;
  posts: Tweet[];
  accounts: string[];
  supportScore: number;
  representative: Tweet;
  cue: string;
}

interface XPromptContext {
  selectedTweets: Tweet[];
  clusters: XHypothesisCluster[];
  accountWeights: XAccountWeightSummary[];
}

interface XThemeSupportSummary {
  clusterCount: number;
  uniqueAccounts: number;
  postCount: number;
  supportScore: number;
  averageAccountWeight: number;
  labels: string[];
}

type ThemeProcessRule = {
  label: string;
  patterns: RegExp[];
  minMatches: number;
  processes: string[];
  why?: string;
  associativeCodes?: string[];
  watchCodes?: string[];
  nextChecks?: string[];
};

// ─── 定数 ──────────────────────────────────────────────────────
const MODEL_ID           = process.env.OPENAI_MODEL?.trim() || "gpt-5-mini";
const MAX_TOKENS         = 3200;
const REASONING_EFFORT   = process.env.OPENAI_REASONING_EFFORT?.trim()
  || (MODEL_ID.startsWith("gpt-5.4") ? "low" : "minimal");
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 2_000;
const MAX_PER_CATEGORY   = 16;   // カテゴリごとの最大投稿数
const MAX_TOTAL_TWEETS   = 60;   // プロンプトに含める最大投稿数
const MAX_TWEET_TEXT_LEN = 120;  // 1投稿あたりの最大文字数
const OPENAI_API_URL     = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 90_000) || 90_000
);
const SOURCE_ORDER       = ["kabutan", "minkabu", "yahoo", "x"] as const;
const MAX_THEME_COUNT            = 5;
const MAX_BACKDROP_THEMES        = 2;
const MAX_INVESTABLE_THEME_COUNT = 4;
const MAX_THEME_NEWS_ITEMS       = 2;
const MAX_THEME_KEY_TWEETS       = 2;
const MAX_STOCK_PICKS            = 6;
const MAX_ASSOCIATIVE_PICKS      = 4;
const MAX_DIRECT_PICKS           = 3;
const MAX_WATCH_CANDIDATES       = 3;
const MAX_PICK_SUPPORTING_NEWS   = 2;
const MAX_NEXT_CHECKS            = 4;
const MAX_SOURCE_REFERENCES      = 8;
const MAX_THEME_SUMMARY_LEN      = 120;
const MAX_PICK_TEXT_LEN          = 130;
const ANALYSIS_OUTPUT_DIR        = path.resolve(__dirname, "../../tmp");
const FULL_ANALYSIS_JSON_PATH    = path.join(ANALYSIS_OUTPUT_DIR, "latest-analysis-full.json");
const FULL_ANALYSIS_MD_PATH      = path.join(ANALYSIS_OUTPUT_DIR, "latest-analysis-full.md");
const PAGES_OUTPUT_DIR           = path.resolve(__dirname, "../../docs");
const PAGES_ANALYSIS_JSON_PATH   = path.join(PAGES_OUTPUT_DIR, "latest-analysis-full.json");
const PAGES_ANALYSIS_MD_PATH     = path.join(PAGES_OUTPUT_DIR, "latest-analysis-full.md");
const LOW_SIGNAL_THEME_PATTERNS = [
  /短期相場観測/i,
  /妙味膨らむ/i,
  /注目銘柄/i,
  /材料株物色/i,
  /値幅取り/i,
  { code: "6723", name: "ルネサスエレクトロニクス", keywords: ["toyota", "nvidia", "worldmodel", "adas", "車載半導体", "マイコン"] },
  { code: "6902", name: "デンソー", keywords: ["toyota", "nvidia", "worldmodel", "自動車", "adas", "車載", "モビリティai"] },
];
const LIST_DRIVEN_THEME_PATTERNS = [
  /ランキング/i,
  /ベスト\d+/i,
  /割安株特集/i,
  /高配当利回り/i,
  /期日到来/i,
  /短期相場観測/i,
];
const THEME_CANONICAL_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "高配当・利回り株", patterns: [/高配当/i, /利回り株/i, /高配当利回り/i, /reit/i, /割安株特集/i] },
  { label: "iPS細胞・再生医療", patterns: [/ips/i, /再生医療/i, /細胞利用/i] },
  { label: "信用期日銘柄の需給", patterns: [/信用.*期日/i, /高値期日/i, /安値期日/i, /期日到来/i] },
  { label: "中東情勢と原油価格", patterns: [/中東情勢/i, /原油価格/i, /ホルムズ/i, /opec/i, /イラン/i, /クウェート/i] },
  { label: "ステーブルコイン・決済", patterns: [/ステーブルコイン/i, /usdc/i, /circle/i, /暗号資産決済/i] },
  { label: "防衛・安全保障", patterns: [/防衛/i, /安全保障/i, /ミサイル/i, /軍事/i] },
];
const X_HIGH_SIGNAL_PATTERNS = [
  /決算/i,
  /上方修正/i,
  /下方修正/i,
  /増配/i,
  /復配/i,
  /自社株買い/i,
  /受注/i,
  /提携/i,
  /承認/i,
  /採用/i,
  /導入/i,
  /開示/i,
  /\bIR\b/i,
  /需給/i,
  /物色/i,
  /資金移動/i,
  /サプライチェーン/i,
  /原油/i,
  /天然ガス/i,
  /ビットコイン/i,
  /\bBTC\b/i,
  /ステーブルコイン/i,
  /USDC/i,
  /防衛/i,
  /データセンター/i,
  /半導体/i,
];
const X_LOW_SIGNAL_PATTERNS = [
  /おはよう/i,
  /おつかれ/i,
  /お疲れ/i,
  /寝る/i,
  /利確/i,
  /損切り/i,
  /ガチホ/i,
  /買いたい/i,
  /売りたい/i,
  /だと思う/i,
  /気がする/i,
  /かな\b/i,
  /雑談/i,
  /笑/i,
  /ｗ{2,}/i,
  /www/i,
  /ランキング/i,
  /ベスト\d+/i,
  /高配当利回り/i,
  /期日到来/i,
];
const X_MARKET_RELEVANCE_PATTERNS = [
  /[（(]\d{4}[)）]/,
  /\b\d{4}\b/,
  /株/i,
  /銘柄/i,
  /決算/i,
  /上方修正/i,
  /下方修正/i,
  /増配/i,
  /復配/i,
  /自社株買い/i,
  /受注/i,
  /提携/i,
  /承認/i,
  /採用/i,
  /導入/i,
  /開示/i,
  /\bIR\b/i,
  /需給/i,
  /物色/i,
  /資金移動/i,
  /サプライチェーン/i,
  /半導体/i,
  /データセンター/i,
  /再生医療/i,
  /iPS/i,
  /原油/i,
  /天然ガス/i,
  /ホルムズ/i,
  /イラン/i,
  /中東/i,
  /防衛/i,
  /ビットコイン/i,
  /\bBTC\b/i,
  /USDC/i,
  /ステーブルコイン/i,
  /暗号資産/i,
  /円安/i,
  /ドル円/i,
  /CPI/i,
  /金利/i,
  /インフレ/i,
  /日経平均/i,
  /TOPIX/i,
  /JDI/i,
];
const X_CLUSTER_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "iPS細胞・再生医療", patterns: [/ips/i, /再生医療/i, /幹細胞/i, /細胞治療/i] },
  { label: "JDI・対米投資", patterns: [/jdi/i, /対米投融資/i, /新工場/i, /2兆円/i] },
  { label: "PCパーツ・メモリ需給", patterns: [/dram/i, /ssd/i, /hdd/i, /メモリ/i, /nand/i, /pcパーツ/i] },
  { label: "中東情勢と原油価格", patterns: [/イラン/i, /イスラエル/i, /ホルムズ/i, /原油/i, /天然ガス/i, /opec/i] },
  { label: "暗号資産・ステーブルコイン", patterns: [/ビットコイン/i, /\bbtc\b/i, /usdc/i, /circle/i, /ステーブルコイン/i, /暗号資産/i] },
  { label: "AIデータセンター・半導体", patterns: [/データセンター/i, /半導体/i, /gpu/i, /hbm/i, /aiサーバー/i, /電線/i, /送配電/i] },
  { label: "マクロ・金利/CPI", patterns: [/cpi/i, /金利/i, /インフレ/i, /fomc/i, /ドル円/i, /長期金利/i] },
  { label: "防衛・安全保障", patterns: [/防衛/i, /安全保障/i, /ミサイル/i, /軍事/i] },
];
const ARTICLE_BUNDLE_THEME_PATTERNS = [
  /決算速報/i,
  /イチオシ決算/i,
  /ランキング/i,
  /高配当/i,
  /株主優待/i,
  /信用期日/i,
  /一覧/i,
  /値上がり率/i,
  /値下がり率/i,
  /材料株/i,
];
const WEAK_INVESTABLE_THEME_PATTERNS = [
  /下請法/i,
  /勧告/i,
  /ガバナンス/i,
  /コンプライアンス/i,
  /不祥事/i,
  /システム障害復旧/i,
  /全品出荷再開/i,
  /出荷再開/i,
];
const THEME_PROCESS_RULES: ThemeProcessRule[] = [
  {
    label: "半導体材料投資拡大で恩恵を受ける素材・前工程",
    patterns: [/半導体材料/i, /jx/i, /権益売却/i, /非鉄/i, /高機能素材/i],
    minMatches: 2,
    processes: ["高機能金属・半導体材料", "前工程向け素材評価", "設備投資に連動する部材需要"],
    why: "権益売却資金が半導体材料へ再配分されると、非鉄・高機能素材や前工程向けの評価/量産需要へ波及しやすいため。",
    associativeCodes: ["4186", "4980", "6920", "7735"],
    watchCodes: ["8035", "6857"],
    nextChecks: [
      "材料・前工程・評価装置への具体波及",
      "採用先や増産計画、設備投資額の具体化",
      "関連企業の受注・提携・量産発表",
    ],
  },
  {
    label: "車載AI・ADAS投資で波及する車載半導体・電子部品",
    patterns: [/toyota/i, /nvidia/i, /worldmodel/i, /adas/i, /車載半導体/i, /マイコン/i],
    minMatches: 2,
    processes: ["車載半導体", "ADAS/ECU", "車載センサー・実装"],
    why: "車載AIやADASの採用が進むと、車載半導体やECU、周辺センサー/実装工程の採用拡大に波及しやすいため。",
  },
  {
    label: "DRAM/NAND需給改善で効くメモリ周辺部材・検査装置",
    patterns: [/dram/i, /nand/i, /メモリ/i, /ssd/i, /hbm/i, /pcパーツ/i],
    minMatches: 2,
    processes: ["メモリ前工程", "後工程・検査", "PC/サーバー向け周辺部材"],
    why: "メモリ需給が改善すると、前工程だけでなく後工程・検査やPC/サーバー向け周辺部材にまで需要が広がりやすいため。",
  },
  {
    label: "対米投資・補助金で再編思惑が出る車載/表示デバイス工程",
    patterns: [/jdi/i, /対米投融資/i, /新工場/i, /液晶/i, /ディスプレイ/i],
    minMatches: 2,
    processes: ["車載表示部材", "液晶/センサー供給網", "設備投資・補助金案件"],
    why: "対米投資や補助金が具体化すると、車載表示やセンサー供給網、設備投資案件に関連する工程へ思惑が波及しやすいため。",
  },
  {
    label: "中東情勢の緊張で波及を受ける資源・海運保険・代替電源",
    patterns: [/イラン/i, /イスラエル/i, /ホルムズ/i, /原油/i, /天然ガス/i, /opec/i],
    minMatches: 2,
    processes: ["資源開発", "原油輸送・海運保険", "代替電源・LNG"],
    why: "中東情勢が原油や輸送の不確実性を高めると、資源開発、海運保険、代替電源関連まで連想が広がりやすいため。",
    associativeCodes: ["1963", "6366", "8766", "9104", "9101"],
    watchCodes: ["1605", "5020"],
    nextChecks: [
      "備蓄放出や供給障害の具体化",
      "LNG・海運保険・代替電源への波及記事",
      "国内設備投資や保全案件の具体化",
    ],
  },
  {
    label: "原発再稼働・設備更新で効く電力設備・保守工程",
    patterns: [/原発/i, /原子力/i, /再稼働/i, /最大限活用/i, /震災15年/i],
    minMatches: 2,
    processes: ["原発設備更新・保守", "送配電・制御システム", "建設・エンジニアリング"],
    why: "原発活用が進む局面では、電力会社本体だけでなく設備更新、保守、送配電制御、建設エンジニアリング工程に需要が波及しやすいため。",
    associativeCodes: ["6501", "7011", "6503"],
    nextChecks: [
      "再稼働スケジュールと設備更新額の具体化",
      "制御・保守・重電向け受注の発生",
    ],
  },
  {
    label: "鉄道保守DXで効く監視・検査ソリューション",
    patterns: [/パンタグラフ/i, /山手線/i, /aiで監視/i, /ドローン/i, /保守/i, /監視/i],
    minMatches: 2,
    processes: ["鉄道設備監視", "検査省力化・ドローン点検", "保守ソフト/センサー"],
    why: "鉄道保守にAIやドローンが入ると、監視、検査省力化、保守ソフト/センサーの需要へ波及しやすいため。",
    associativeCodes: ["6503", "6701", "6946"],
    watchCodes: ["9020"],
    nextChecks: [
      "採用事例・受注・提携の具体化",
      "センサーや監視ソフトの導入先拡大",
      "鉄道保守DXの設備投資計画",
    ],
  },
  {
    label: "鉄道イベント化で効く旅客サービス・観光消費",
    patterns: [/特急列車/i, /宿泊イベント/i, /jr九州/i, /ホテル不足/i, /観光/i],
    minMatches: 2,
    processes: ["旅客サービス企画", "観光送客", "周辺消費・宿泊連携"],
    why: "鉄道車両のイベント活用は、旅客サービス企画だけでなく観光送客や周辺消費・宿泊連携まで波及しやすいため。",
    associativeCodes: ["2477", "6030", "9722"],
    watchCodes: ["9142"],
    nextChecks: [
      "イベント継続実施と収益化の確認",
      "宿泊・旅行・決済連携の具体化",
      "送客数や客単価などの定量情報",
    ],
  },
  {
    label: "ステーブルコイン普及で広がる決済・送金インフラ",
    patterns: [/usdc/i, /circle/i, /ステーブルコイン/i, /決済/i, /送金/i],
    minMatches: 2,
    processes: ["決済インフラ", "送金/本人確認", "証券・取引所API"],
    why: "ステーブルコイン関連の話題は、決済/送金や本人確認、証券・取引所APIなどの周辺インフラに波及しやすいため。",
    associativeCodes: ["6701", "6702"],
    nextChecks: [
      "国内送金・決済での採用事例",
      "認証や決済インフラとの提携発表",
    ],
  },
  {
    label: "iPS・再生医療で波及する培養/製造受託・周辺試薬",
    patterns: [/ips/i, /再生医療/i, /幹細胞/i, /細胞治療/i],
    minMatches: 2,
    processes: ["細胞培養・製造受託", "周辺試薬/設備", "治験・提携"],
    why: "iPSや再生医療の進展は、創薬本体だけでなく細胞培養、製造受託、周辺試薬/設備の工程に波及しやすいため。",
  },
];
const MARKET_BACKDROP_PATTERNS = [
  /ドル円/i,
  /円高/i,
  /円安/i,
  /原油/i,
  /中東/i,
  /ホルムズ/i,
  /opec/i,
  /cpi/i,
  /fomc/i,
  /金利/i,
  /為替/i,
  /米雇用/i,
];
const ANALYZER_DEBUG_X = process.env.ANALYZER_DEBUG_X === "1";

// ─── システムプロンプト ────────────────────────────────────────
const SYSTEM_PROMPT = `あなたは日本株の「風が吹けば桶屋が儲かる」的な連想投資の専門家です。
以下はX（Twitter）の日本株投資家クラスタの直近12時間の投稿です。

【最重要ルール】
- 投稿の中から「具体的な企業名・銘柄コード・業界テーマ」の言及を抽出すること
- 「システムエラー」「API障害」などの技術的ノイズは完全に無視すること
- 実際に投資家が議論している銘柄・テーマだけを分析対象にすること

【分析手順】
1. 投稿から最も多く言及されている「投資テーマ・セクター・銘柄」を特定
2. そのテーマから3段階以上の連想を展開
   例: 半導体需要→EUV露光装置→レジスト薬品→東京応化工業
   例: 防衛費増額→艦艇建造→特殊鋼材→大同特殊鋼
   例: インバウンド急増→地方観光→交通インフラ→新潟トランシス
3. 連想の終点にある「まだ市場で注目されていない隠れた受益企業」を発掘
4. 直接的に言及されている銘柄ではなく、サプライチェーン上流や
   ニッチな部品・素材メーカーを優先すること
5. 時価総額500億円以下の小型株を優先すること

【出力ルール】
- 必ず実在する銘柄コード（4桁）を付与
- 確度スコアは投稿での言及頻度と連想の論理的強度で決定
- 最低5銘柄、できれば8銘柄を推薦
- 各銘柄に「いつ買い」「目標株価レンジ」は不要（法的リスク）

【出力フォーマット（JSON）】
{
  "analysis_date": "YYYY-MM-DD HH:mm",
  "trending_themes": [
    {
      "theme": "テーマ名",
      "mention_count": 数値,
      "key_tweets": ["投稿要約1", "投稿要約2"]
    }
  ],
  "stock_picks": [
    {
      "rank": 1,
      "code": "証券コード",
      "name": "企業名",
      "chain": "テーマ→中間要素→...→この銘柄",
      "reasoning": "なぜこの銘柄が恩恵を受けるか",
      "confidence": 8,
      "risk": "主なリスク",
      "catalyst": "株価が動くきっかけ"
    }
  ],
  "market_sentiment": "全体の雰囲気サマリー"
}

回答はJSONのみ。コードブロック・説明文は不要。`;

// ─── ユーティリティ ────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REPORT_SYSTEM_PROMPT = `
あなたは、日本株の朝夕配信用レポートを作る編集者です。
入力として渡されるのは、直近12時間以内に取得した x / kabutan / minkabu / yahoo の情報です。
ニュース根拠を明確にした JSON を返してください。

厳守:
- 入力にない事実を補わない
- 根拠が弱い内容は断定しない
- source は x / kabutan / minkabu / yahoo のいずれかにする
- url と timestamp は入力にある場合だけ使う
- news_items は重要度順に並べる
- stock_picks はどのテーマ/ニュースが根拠か追えるようにする
- JSON だけを返す

JSON schema:
{
  "analysis_date": "YYYY-MM-DD HH:mm",
  "trending_themes": [
    {
      "theme": "テーマ名",
      "mention_count": 12,
      "why_it_matters": "なぜ市場で効くかを1〜3文で説明",
      "key_tweets": ["要点1", "要点2"],
      "news_items": [
        {
          "headline": "見出し",
          "summary": "1〜3行の要約",
          "source": "kabutan",
          "url": "https://...",
          "timestamp": "2026-03-07T19:30:00+09:00",
          "importance": 5
        }
      ]
    }
  ],
  "stock_picks": [
    {
      "rank": 1,
      "code": "8035",
      "name": "東京エレクトロン",
      "chain": "テーマ -> 需給/業績/政策 -> 銘柄 の連想経路",
      "reasoning": "その銘柄を挙げる理由",
      "confidence": 8,
      "risk": "主なリスク",
      "catalyst": "直近カタリスト",
      "root_theme": "根拠テーマ",
      "supporting_news": ["根拠ニュース1", "根拠ニュース2"]
    }
  ],
  "market_sentiment": "市場センチメント",
  "source_list": [
    {
      "source": "minkabu",
      "headline": "見出し",
      "url": "https://...",
      "timestamp": "2026-03-07T16:54:00+09:00"
    }
  ]
}

要件:
- trending_themes は最大5件
- 各テーマの news_items は最大2件
- stock_picks は最大8件
- source_list は重複を避けて最大10件
`;

const COMPACT_REPORT_SYSTEM_PROMPT = `
Return one complete JSON object only. No markdown.
Write descriptive values in Japanese.
Use only evidence from the input. If unsure, omit rather than guess.
If the response may become long, reduce item counts first. Never cut off JSON.
Theme names must be investor-usable and specific, not vague labels like "注目", "関連株", "短期妙味", or "物色" alone.
Merge the same story across kabutan / minkabu / yahoo into one theme when they describe the same event.
If the evidence is only a ranking, screening list, columnist roundup, or credit-expiry list, keep the theme but do not force a stock pick unless the company linkage is explicit.
Prefer investable theme names that already imply where the benefit lands in Japan equities, not mere article bundles like "決算速報リスト" or "監督強化".
When possible, express investable ideas as "theme -> structural change -> beneficiary process" before naming any company.
For stock picks, prefer real Japan-listed companies with actual 4-digit stock codes.
Never output placeholders such as 代表例, 関連株, N/A, 0000, or generic labels.
If the theme is valid but a direct company is not explicit, choose the most relevant liquid TSE-listed company only when the business linkage is still concrete. Otherwise omit.
Prefer direct beneficiaries whose business segment clearly connects to the theme.
Avoid broad conglomerates or large general names when the linkage is weak or only market-wide.
If the link cannot be explained as theme -> business -> earnings impact, omit the pick instead of filling the slot.
Keep root_theme and supporting news traceable to the cited theme/news.
Use x_hypotheses only as associative/watch hypothesis seeds, not as a replacement for direct news.
If a theme is supported only by x_hypotheses, prefer watch-style interpretation unless another source or explicit business linkage confirms it.

Use this compact schema:
{
  "d": "YYYY-MM-DD HH:mm",
  "themes": [
    {
      "t": "テーマ名",
      "mc": 12,
      "why": "なぜ重要かを短く1文",
      "kt": ["補足ポイント"],
      "news": [
        {
          "h": "見出し",
          "sum": "要点を短く1文",
          "src": "kabutan",
          "ts": "2026-03-07T19:30:00+09:00",
          "u": "https://..."
        }
      ]
    }
  ],
  "picks": [
    {
      "r": 1,
      "c": "8035",
      "n": "東京エレクトロン",
      "ch": "連想経路を短く",
      "re": "理由を短く",
      "cf": 8,
      "risk": "主なリスクを短く",
      "cat": "カタリストを短く",
      "rt": "根拠テーマ",
      "sn": ["根拠ニュース"]
    }
  ],
  "sent": "市場センチメントを短く",
  "sources": [
    {
      "src": "yahoo",
      "h": "見出し",
      "ts": "2026-03-07T16:54:00+09:00",
      "u": "https://..."
    }
  ]
}

Limits:
- themes max 5
- kt max 2 per theme
- news max 2 per theme
- picks max 6
- sn max 2 per pick
- sources max 8
- why / sum / re / risk / cat / sent are each 1 short sentence
- It is acceptable to return fewer than 6 picks when evidence is weak
`;

/** システムエラー系・空テキスト等のノイズ投稿かどうか判定する */
function isNoiseTweet(text: string): boolean {
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

/** ソース別にグループ化 */
function groupBySource(tweets: Tweet[]): Record<string, Tweet[]> {
  const groups: Record<string, Tweet[]> = {};
  for (const tweet of tweets) {
    (groups[tweet.source] ??= []).push(tweet);
  }
  return groups;
}

function normalizeHeadlineKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[【】［］\[\]（）()＜＞<>「」『』・:：!！?？,，.。]/g, "");
}

function sourceRank(source: Tweet["source"]): number {
  return SOURCE_ORDER.indexOf(source as (typeof SOURCE_ORDER)[number]);
}

function pickPreferredDuplicate(current: Tweet, candidate: Tweet): Tweet {
  const currentRank = sourceRank(current.source);
  const candidateRank = sourceRank(candidate.source);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank ? candidate : current;
  }

  const currentScore = (current.summary?.length ?? 0) + (current.text?.length ?? 0);
  const candidateScore = (candidate.summary?.length ?? 0) + (candidate.text?.length ?? 0);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  return new Date(candidate.timestamp).getTime() > new Date(current.timestamp).getTime()
    ? candidate
    : current;
}

function dedupeAnalysisTweets(tweets: Tweet[]): Tweet[] {
  const dedupedX: Tweet[] = [];
  const dedupedNews = new Map<string, Tweet>();

  for (const tweet of tweets) {
    if (tweet.source === "x") {
      dedupedX.push(tweet);
      continue;
    }

    const headline = tweet.headline ?? tweet.text;
    const key = normalizeHeadlineKey(headline);
    if (!key) continue;
    const current = dedupedNews.get(key);
    dedupedNews.set(key, current ? pickPreferredDuplicate(current, tweet) : tweet);
  }

  return [...dedupedX, ...dedupedNews.values()].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/** 投稿テキストを整形（長すぎる場合は切り詰め） */
function truncate(text: string, max = MAX_TWEET_TEXT_LEN): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function formatPromptTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeXPromptIdentity(text: string): string {
  return normalizeHeadlineKey(
    text
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[@#][\w_]+/g, " ")
      .replace(/\b\d{1,2}:\d{2}\b/g, " ")
      .slice(0, 180)
  );
}

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function scoreXPromptSignal(tweet: Tweet): number {
  if (tweet.source !== "x") return 0;

  const text = tweet.text ?? "";
  const highSignalMatches = countPatternMatches(text, X_HIGH_SIGNAL_PATTERNS);
  const lowSignalMatches = countPatternMatches(text, X_LOW_SIGNAL_PATTERNS);
  let score = 0;

  if (/https?:\/\//i.test(text)) score += 2;
  if (/[（(]\d{4}[)）]/.test(text) || /\b\d{4}\b/.test(text)) score += 3;
  if (/\d+(?:\.\d+)?%/.test(text)) score += 2;
  if (/\d+(?:\.\d+)?(?:億円|万株|円|ドル|件|基|台|倍|bps?|BP)/i.test(text)) score += 2;
  if (/[A-Z]{2,5}/.test(text)) score += 1;
  if (text.length >= 55) score += 1;
  score += Math.min(4, highSignalMatches);
  score -= Math.min(4, lowSignalMatches);

  if (!/[（(]\d{4}[)）]/.test(text) && !/\d+(?:\.\d+)?(?:%|億円|万株|円|ドル|件|基|台|倍)/.test(text)) {
    score -= 1;
  }

  return score;
}

function xPromptSignalLevel(tweet: Tweet): "high" | "mid" | "low" {
  const score = scoreXPromptSignal(tweet);
  if (score >= 7) return "high";
  if (score >= 3) return "mid";
  return "low";
}

function xPromptSignalTags(tweet: Tweet): string[] {
  if (tweet.source !== "x") return [];

  const text = tweet.text ?? "";
  const tags: string[] = [];
  if (/[（(]\d{4}[)）]/.test(text) || /\b\d{4}\b/.test(text)) tags.push("code");
  if (/https?:\/\//i.test(text)) tags.push("link");
  if (/\d+(?:\.\d+)?(?:%|億円|万株|円|ドル|件|基|台|倍)/.test(text)) tags.push("number");
  if (/(需給|物色|資金移動|ショート|先物|ETF)/.test(text)) tags.push("flow");
  if (/(受注|提携|承認|採用|導入|IR|開示|決算|上方修正|下方修正)/i.test(text)) tags.push("fact");
  if (/(半導体|原油|天然ガス|ビットコイン|BTC|USDC|ステーブルコイン|防衛|データセンター)/i.test(text)) {
    tags.push("theme");
  }
  return tags.slice(0, 3);
}

function isMarketRelevantXPrompt(tweet: Tweet): boolean {
  if (tweet.source !== "x") return true;
  const text = tweet.text ?? "";
  return X_MARKET_RELEVANCE_PATTERNS.some((pattern) => pattern.test(text));
}

function countExplicitListedMentions(text: string): number {
  const normalized = normalizeMatchText(text);
  let count = 0;

  for (const candidate of ALL_STOCK_FALLBACK_CANDIDATES) {
    const codeMatch = normalized.includes(candidate.code);
    const nameMatch = normalized.includes(normalizeMatchText(candidate.name));
    if (codeMatch || nameMatch) count++;
    if (count >= 2) break;
  }

  return count;
}

function detectXClusterLabel(tweet: Tweet): string | undefined {
  if (tweet.source !== "x") return undefined;
  const text = tweet.text ?? "";

  const explicitCode = text.match(/[（(](\d{4})[)）]/)?.[1] ?? text.match(/\b(\d{4})\b/)?.[1];
  if (explicitCode) {
  const matchedCandidate = ALL_STOCK_FALLBACK_CANDIDATES.find((candidate) => candidate.code === explicitCode);
    if (matchedCandidate) return `${matchedCandidate.name}(${matchedCandidate.code})`;
  }

  for (const rule of X_CLUSTER_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.label;
    }
  }

  const explicitCandidate = ALL_STOCK_FALLBACK_CANDIDATES.find((candidate) => {
    const normalized = normalizeMatchText(text);
    return normalized.includes(normalizeMatchText(candidate.name));
  });
  if (explicitCandidate) {
    return `${explicitCandidate.name}(${explicitCandidate.code})`;
  }

  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeXAccountWeight(
  summary: Omit<XAccountWeightSummary, "weight">,
  clusterCount: number
): number {
  const total = Math.max(1, summary.totalPosts);
  const relevantRate = summary.marketRelevantPosts / total;
  const highRate = summary.highSignalPosts / total;
  const lowRate = summary.lowSignalPosts / total;
  const linkRate = summary.linkPosts / Math.max(1, summary.marketRelevantPosts);
  const structuredRate = summary.structuredPosts / Math.max(1, summary.marketRelevantPosts);
  const earlyRate = summary.earlyClusterMentions / Math.max(1, clusterCount);
  const avgSignal = clamp(summary.averageSignal / 8, 0, 1);

  return Number(
    clamp(
      0.65 +
        relevantRate * 0.35 +
        highRate * 0.2 +
        linkRate * 0.12 +
        structuredRate * 0.18 +
        earlyRate * 0.2 +
        avgSignal * 0.15 -
        lowRate * 0.28,
      0.45,
      1.65
    ).toFixed(2)
  );
}

function buildXPromptContext(tweets: Tweet[]): XPromptContext {
  const rawXTweets = tweets.filter((tweet) => tweet.source === "x");
  if (rawXTweets.length === 0) {
    return { selectedTweets: [], clusters: [], accountWeights: [] };
  }

  const accountMap = new Map<string, Omit<XAccountWeightSummary, "weight">>();
  for (const tweet of rawXTweets) {
    const username = tweet.username || "unknown";
    const current = accountMap.get(username) ?? {
      username,
      totalPosts: 0,
      marketRelevantPosts: 0,
      highSignalPosts: 0,
      lowSignalPosts: 0,
      linkPosts: 0,
      structuredPosts: 0,
      earlyClusterMentions: 0,
      averageSignal: 0,
    };

    const signal = scoreXPromptSignal(tweet);
    current.totalPosts += 1;
    current.averageSignal += signal;
    if (isMarketRelevantXPrompt(tweet)) current.marketRelevantPosts += 1;
    if (signal >= 7) current.highSignalPosts += 1;
    if (signal <= 2) current.lowSignalPosts += 1;
    if (/https?:\/\//i.test(tweet.text ?? "")) current.linkPosts += 1;
    if (
      /[（(]\d{4}[)）]/.test(tweet.text ?? "") ||
      /\b\d{4}\b/.test(tweet.text ?? "") ||
      /\d+(?:\.\d+)?(?:%|億円|万株|円|ドル|件|基|台|倍)/.test(tweet.text ?? "") ||
      /(決算|上方修正|下方修正|増配|自社株買い|受注|提携|承認|採用|導入|IR|開示)/i.test(tweet.text ?? "") ||
      countExplicitListedMentions(tweet.text ?? "") > 0
    ) {
      current.structuredPosts += 1;
    }

    accountMap.set(username, current);
  }

  const relevantXTweets = rawXTweets.filter(shouldIncludePromptTweet);
  const clusterMap = new Map<string, XHypothesisCluster>();

  for (const tweet of relevantXTweets) {
    const label = detectXClusterLabel(tweet);
    if (!label) continue;
    const key = normalizeHeadlineKey(label);
    const current = clusterMap.get(key);
    if (!current) {
      clusterMap.set(key, {
        key,
        label,
        posts: [tweet],
        accounts: [tweet.username],
        supportScore: 0,
        representative: tweet,
        cue: truncate(tweet.text, 80),
      });
      continue;
    }

    current.posts.push(tweet);
    if (!current.accounts.includes(tweet.username)) current.accounts.push(tweet.username);
    if (scoreXPromptSignal(tweet) > scoreXPromptSignal(current.representative)) {
      current.representative = tweet;
      current.cue = truncate(tweet.text, 80);
    }
  }

  const provisionalClusterCount = Math.max(1, clusterMap.size);
  const provisionalWeights = new Map<string, number>();
  for (const summary of accountMap.values()) {
    const avgSignal = summary.totalPosts > 0 ? summary.averageSignal / summary.totalPosts : 0;
    provisionalWeights.set(
      summary.username,
      computeXAccountWeight({ ...summary, averageSignal: avgSignal }, provisionalClusterCount)
    );
  }

  for (const cluster of clusterMap.values()) {
    const earliest = Math.min(...cluster.posts.map((tweet) => new Date(tweet.timestamp).getTime()));
    for (const tweet of cluster.posts) {
      if (new Date(tweet.timestamp).getTime() <= earliest + 30 * 60 * 1000) {
        const summary = accountMap.get(tweet.username);
        if (summary) summary.earlyClusterMentions += 1;
      }
    }
  }

  const accountWeights = Array.from(accountMap.values())
    .map((summary) => {
      const averageSignal = summary.totalPosts > 0 ? summary.averageSignal / summary.totalPosts : 0;
      return {
        ...summary,
        averageSignal: Number(averageSignal.toFixed(2)),
        weight: computeXAccountWeight({ ...summary, averageSignal }, provisionalClusterCount),
      };
    })
    .sort((a, b) => b.weight - a.weight || b.marketRelevantPosts - a.marketRelevantPosts);
  const accountWeightMap = new Map(accountWeights.map((summary) => [summary.username, summary]));

  const clusters = Array.from(clusterMap.values())
    .map((cluster) => {
      const totalSignal = cluster.posts.reduce((sum, tweet) => sum + scoreXPromptSignal(tweet), 0);
      const avgSignal = totalSignal / Math.max(1, cluster.posts.length);
      const avgWeight = cluster.accounts.reduce((sum, username) => {
        return sum + (accountWeightMap.get(username)?.weight ?? 0.8);
      }, 0) / Math.max(1, cluster.accounts.length);
      const earliest = Math.min(...cluster.posts.map((tweet) => new Date(tweet.timestamp).getTime()));
      const earlyAccounts = new Set(
        cluster.posts
          .filter((tweet) => new Date(tweet.timestamp).getTime() <= earliest + 30 * 60 * 1000)
          .map((tweet) => tweet.username)
      ).size;

      return {
        ...cluster,
        supportScore: Number(
          (
            cluster.posts.length * 1.2 +
            cluster.accounts.length * 3.2 +
            earlyAccounts * 1.4 +
            avgSignal * 0.9 +
            avgWeight * 1.4 +
            (cluster.accounts.length >= 2 ? 2.2 : 0)
          ).toFixed(2)
        ),
      };
    })
    .sort((a, b) => b.supportScore - a.supportScore || b.accounts.length - a.accounts.length);
  const clusterScoreMap = new Map(clusters.map((cluster) => [cluster.key, cluster.supportScore]));

  const selected: Tweet[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    const representative = [...cluster.posts].sort((a, b) => {
      const signalDiff = scoreXPromptSignal(b) - scoreXPromptSignal(a);
      if (signalDiff !== 0) return signalDiff;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    })[0];
    const key = promptIdentity(representative);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(representative);
    }
  }

  const remaining = relevantXTweets
    .filter((tweet) => !seen.has(promptIdentity(tweet)))
    .sort((a, b) => {
      const aClusterScore = clusterScoreMap.get(normalizeHeadlineKey(detectXClusterLabel(a) ?? "")) ?? 0;
      const bClusterScore = clusterScoreMap.get(normalizeHeadlineKey(detectXClusterLabel(b) ?? "")) ?? 0;
      const aWeight = accountWeightMap.get(a.username)?.weight ?? 0.8;
      const bWeight = accountWeightMap.get(b.username)?.weight ?? 0.8;
      const aPriority = aClusterScore * 2 + aWeight + scoreXPromptSignal(a) * 1.5;
      const bPriority = bClusterScore * 2 + bWeight + scoreXPromptSignal(b) * 1.5;
      if (bPriority !== aPriority) return bPriority - aPriority;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

  for (const tweet of remaining) {
    const key = promptIdentity(tweet);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(tweet);
  }

  return { selectedTweets: selected, clusters, accountWeights };
}

function formatXClusterPromptLine(cluster: XHypothesisCluster): string {
  return `- cluster=${cluster.label} | accounts=${cluster.accounts.length} | posts=${cluster.posts.length} | strength=${cluster.supportScore.toFixed(1)} | cue=${truncate(cluster.cue, 70)}`;
}

function matchesXClusterTheme(cluster: XHypothesisCluster, theme: TrendingTheme): boolean {
  const haystack = combineThemeEvidence(theme);
  const normalizedLabel = normalizeMatchText(cluster.label);
  if (normalizedLabel && haystack.includes(normalizedLabel)) return true;

  const clusterRule = X_CLUSTER_RULES.find((rule) => rule.label === cluster.label);
  if (clusterRule && clusterRule.patterns.some((pattern) => pattern.test(haystack))) {
    return true;
  }

  const cue = normalizeMatchText(cluster.cue);
  if (cue && (haystack.includes(cue.slice(0, 24)) || cue.includes(normalizeMatchText(theme.theme)))) {
    return true;
  }

  return cluster.posts.some((post) => {
    const normalizedText = normalizeMatchText(post.text);
    return normalizedText && (
      haystack.includes(normalizedText.slice(0, 28)) ||
      normalizedText.includes(normalizeMatchText(theme.theme))
    );
  });
}

function summarizeThemeXSupport(
  theme: TrendingTheme,
  xContext?: XPromptContext
): XThemeSupportSummary | undefined {
  if (!xContext || xContext.clusters.length === 0) return undefined;

  const matchedClusters = xContext.clusters.filter((cluster) => matchesXClusterTheme(cluster, theme));
  if (matchedClusters.length === 0) return undefined;

  const accounts = new Set<string>();
  let postCount = 0;
  let supportScore = 0;
  let accountWeightTotal = 0;
  let accountWeightCount = 0;

  for (const cluster of matchedClusters) {
    postCount += cluster.posts.length;
    supportScore += cluster.supportScore;
    for (const username of cluster.accounts) {
      accounts.add(username);
      const weight = xContext.accountWeights.find((summary) => summary.username === username)?.weight;
      if (typeof weight === "number") {
        accountWeightTotal += weight;
        accountWeightCount += 1;
      }
    }
  }

  return {
    clusterCount: matchedClusters.length,
    uniqueAccounts: accounts.size,
    postCount,
    supportScore: Number(supportScore.toFixed(2)),
    averageAccountWeight: Number(
      (accountWeightCount > 0 ? accountWeightTotal / accountWeightCount : 0).toFixed(2)
    ),
    labels: matchedClusters.map((cluster) => cluster.label),
  };
}

function shouldIncludePromptTweet(tweet: Tweet): boolean {
  if (isNoiseTweet(tweet.text)) return false;
  if (tweet.source === "x" && !isMarketRelevantXPrompt(tweet)) return false;
  if (tweet.source === "x" && scoreXPromptSignal(tweet) < 0) return false;
  return true;
}

function comparePromptTweets(a: Tweet, b: Tweet): number {
  if (a.source === "x" && b.source === "x") {
    const signalDiff = scoreXPromptSignal(b) - scoreXPromptSignal(a);
    if (signalDiff !== 0) return signalDiff;
  }
  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}

function formatPromptLine(tweet: Tweet): string {
  const parts: string[] = [
    `[${tweet.source}]`,
    formatPromptTimestamp(tweet.timestamp),
  ];

  if (tweet.source === "x") {
    parts.push(`account=@${tweet.username}`);
    parts.push(`signal=${xPromptSignalLevel(tweet)}`);
    const tags = xPromptSignalTags(tweet);
    if (tags.length > 0) parts.push(`tags=${tags.join("+")}`);
    parts.push(`text=${truncate(tweet.text)}`);
  } else {
    parts.push(`headline=${truncate(tweet.headline ?? tweet.text, 100)}`);
    if (tweet.summary) parts.push(`summary=${truncate(tweet.summary, 80)}`);
    if (tweet.category) parts.push(`category=${tweet.category}`);
    if (tweet.url) parts.push(`url=${truncate(tweet.url, 120)}`);
  }

  return `- ${parts.join(" | ")}`;
}

function getOrderedSources(grouped: Record<string, Tweet[]>): string[] {
  const present = new Set(Object.keys(grouped));
  return [
    ...SOURCE_ORDER.filter((source) => present.has(source)),
    ...Object.keys(grouped).filter(
      (source) => !SOURCE_ORDER.includes(source as (typeof SOURCE_ORDER)[number])
    ),
  ];
}

function promptIdentity(tweet: Tweet): string {
  if (tweet.source === "x") {
    return `${tweet.source}|${tweet.username}|${normalizeXPromptIdentity(tweet.text)}`;
  }
  return `${tweet.source}|${truncate(tweet.headline ?? tweet.text, 80)}`;
}

function selectPromptTweets(
  tweets: Tweet[],
  perCategoryLimit: number
): Tweet[] {
  if (tweets.some((tweet) => tweet.source === "x")) {
    return buildXPromptContext(tweets).selectedTweets.slice(0, perCategoryLimit);
  }

  const seen = new Set<string>();
  const selected: Tweet[] = [];

  for (const tweet of tweets
    .filter(shouldIncludePromptTweet)
    .sort(comparePromptTweets)) {
    const key = promptIdentity(tweet);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(tweet);
    if (selected.length >= perCategoryLimit) break;
  }

  return selected;
}

function getPromptLimits(attempt: number): { perCategory: number; total: number } {
  if (attempt <= 1) {
    return { perCategory: MAX_PER_CATEGORY, total: MAX_TOTAL_TWEETS };
  }
  if (attempt === 2) {
    return { perCategory: 10, total: 40 };
  }
  return { perCategory: 8, total: 28 };
}

/** プロンプト用の投稿リストを組み立て */
function buildUserPrompt(
  grouped: Record<string, Tweet[]>,
  analysisDate: string
): string {
  const lines: string[] = [
    `分析日時: ${analysisDate}`,
    "",
    "## 収集した投稿・ニュース（過去12時間）",
    "",
  ];

  let totalCount = 0;

  for (const [source, tweets] of Object.entries(grouped)) {
    // ソースごとに最新順で上限まで絞り込み、ノイズを除外
    const slice = tweets
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .filter((t) => !isNoiseTweet(t.text))
      .slice(0, MAX_PER_CATEGORY);

    if (slice.length === 0) continue;

    lines.push(`### ${source}（${slice.length} 件）`);

    for (const tweet of slice) {
      if (totalCount >= MAX_TOTAL_TWEETS) break;
      const ts = new Date(tweet.timestamp).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      lines.push(`- @${tweet.username} (${ts}): ${truncate(tweet.text)}`);
      totalCount++;
    }

    lines.push("");
    if (totalCount >= MAX_TOTAL_TWEETS) break;
  }

  lines.push(`（合計 ${totalCount} 件を分析対象とする）`);
  lines.push("");
  lines.push("上記の投稿を分析し、指定の JSON フォーマットで回答してください。");

  return lines.join("\n");
}

function buildStructuredUserPrompt(
  grouped: Record<string, Tweet[]>,
  analysisDate: string,
  attempt = 1
): string {
  const limits = getPromptLimits(attempt);
  const lines: string[] = [
    `分析日時: ${analysisDate}`,
    "",
    "## 入力ニュース一覧（直近12時間）",
    "",
  ];

  let totalCount = 0;

  for (const source of getOrderedSources(grouped)) {
    const tweets = grouped[source] ?? [];
    const slice = selectPromptTweets(tweets, limits.perCategory);

    if (slice.length === 0) continue;

    lines.push(`### ${source} (${slice.length}件)`);

    for (const tweet of slice) {
      if (totalCount >= limits.total) break;
      lines.push(formatPromptLine(tweet));
      totalCount++;
    }

    lines.push("");
    if (totalCount >= limits.total) break;
  }

  lines.push(`合計 ${totalCount} 件を分析対象にしてください。`);
  lines.push("");
  lines.push("上記だけを根拠に、ニュース根拠付きの JSON を返してください。");

  return lines.join("\n");
}

/** テキストから JSON ブロックを抽出（コードフェンス対応） */
function buildCompactUserPrompt(
  grouped: Record<string, Tweet[]>,
  analysisDate: string,
  attempt = 1,
  xContext?: XPromptContext
): string {
  const limits = getPromptLimits(attempt);
  const currentXContext = xContext ?? buildXPromptContext(grouped.x ?? []);
  const lines: string[] = [
    `analysis_date: ${analysisDate}`,
    "",
    "Use only the following source-backed inputs from the last 12 hours.",
    "Prioritize concrete themes, source-backed reasoning, up to two supporting news items per theme, and up to six real Japan-listed stock picks.",
    "Treat the same story across kabutan / minkabu / yahoo as one event when naming themes.",
    "If evidence is only a ranking or roundup article, keep stock picks conservative and omit weak ones.",
    "Keep market_backdrop themes such as FX, crude oil, Middle East, rates, or CPI concise. Limit them to one or two short backdrop ideas mentally, and prioritize investable Japan-equity themes.",
    "Prefer investable themes that can be explained as theme -> structural change -> demand ripple -> beneficiary process -> company.",
    "Avoid article-bundle theme labels such as generic earnings roundups or governance alerts unless you can restate them as a concrete investable process/theme.",
    "Do not let market_backdrop themes dominate the answer unless they clearly connect to Japan-listed beneficiaries or watch conditions.",
    "For x posts, weigh primary-source links, concrete numbers, company names/codes, supply-chain hints, and flow/sector observations more heavily than opinions or hype.",
    "Treat x-only observations as hypothesis seeds. Promote them to main picks only when concrete business linkage or another source supports them; otherwise keep them as watch candidates.",
    "Use x_hypotheses for associative/watch ideas first. Do not use them as direct-news substitutes.",
    "",
  ];

  let totalCount = 0;

  if (currentXContext.clusters.length > 0) {
    lines.push(`### x_hypotheses (${Math.min(4, currentXContext.clusters.length)})`);
    for (const cluster of currentXContext.clusters.slice(0, 4)) {
      if (totalCount >= limits.total) break;
      lines.push(formatXClusterPromptLine(cluster));
      totalCount++;
    }
    lines.push("");
  }

  for (const source of getOrderedSources(grouped)) {
    const tweets = grouped[source] ?? [];
    const slice = source === "x"
      ? currentXContext.selectedTweets.slice(0, Math.min(limits.perCategory, 6))
      : selectPromptTweets(tweets, limits.perCategory);

    if (slice.length === 0) continue;

    lines.push(`### ${source} (${slice.length})`);

    for (const tweet of slice) {
      if (totalCount >= limits.total) break;
      lines.push(formatPromptLine(tweet));
      totalCount++;
    }

    lines.push("");
    if (totalCount >= limits.total) break;
  }

  lines.push(`total_items: ${totalCount}`);
  lines.push("");
  lines.push("Return the compact JSON schema exactly. Keep every field short and evidence-based.");

  return lines.join("\n");
}

function extractJson(text: string): string {
  // ```json ... ``` または ``` ... ``` のフェンスを除去
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // JSON オブジェクトの先頭 { から末尾 } を探す
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

function stripTrailingCommas(jsonText: string): string {
  return jsonText.replace(/,\s*([}\]])/g, "$1");
}

function closeTruncatedJson(jsonText: string): string {
  const trimmed = jsonText.trim();
  let candidate = trimmed;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

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
      stack.push("}");
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      continue;
    }
    if ((ch === "}" || ch === "]") && stack.length > 0 && stack[stack.length - 1] === ch) {
      stack.pop();
      if (stack.length === 0) {
        lastBalancedIndex = i;
      }
    }
  }

  if (lastBalancedIndex !== -1) {
    return stripTrailingCommas(trimmed.slice(0, lastBalancedIndex + 1));
  }

  if (inString) candidate += "\"";
  candidate = candidate.replace(/[,:]\s*$/, "");
  candidate = stripTrailingCommas(candidate);
  candidate += stack.reverse().join("");
  return candidate;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const extracted = extractJson(text);
  const candidates = Array.from(new Set([
    extracted,
    closeTruncatedJson(extracted),
  ]));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to parse JSON");
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return "";
}

function pickArray(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown, max = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asString)
    .filter(Boolean)
    .slice(0, max);
}

function asImportance(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(5, Math.max(1, Math.round(num)));
}

function normalizeSource(value: unknown): ThemeNewsItem["source"] {
  const source = asString(value).toLowerCase();
  if (source === "kabutan" || source === "minkabu" || source === "yahoo" || source === "x") {
    return source;
  }
  return "x";
}

function timestampValue(timestamp?: string): number {
  if (!timestamp) return 0;
  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function isGenericNewsUrl(url?: string): boolean {
  const value = asString(url).trim();
  if (!value) return true;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    if (host === "kabutan.jp") return path === "/";
    if (host === "news.yahoo.co.jp" || host === "finance.yahoo.co.jp") return path === "/";
    if (host === "minkabu.jp") return path === "/";
    return false;
  } catch {
    return true;
  }
}

function sanitizeNewsUrl(url?: string): string | undefined {
  const value = asString(url).trim();
  if (!value || isGenericNewsUrl(value)) return undefined;
  return value;
}

function preferredRoleRank(role?: SourceReference["role"]): number {
  if (role === "investable") return 4;
  if (role === "sector_watch") return 3;
  if (role === "process_watch") return 2;
  return role === "backdrop" ? 1 : 0;
}

function preferThemeNewsItem(current: ThemeNewsItem, candidate: ThemeNewsItem): ThemeNewsItem {
  const currentImportance = current.importance ?? 0;
  const candidateImportance = candidate.importance ?? 0;
  if (candidateImportance !== currentImportance) {
    return candidateImportance > currentImportance ? candidate : current;
  }

  const currentSummaryScore = (current.summary?.length ?? 0) + (current.url ? 20 : 0);
  const candidateSummaryScore = (candidate.summary?.length ?? 0) + (candidate.url ? 20 : 0);
  if (candidateSummaryScore !== currentSummaryScore) {
    return candidateSummaryScore > currentSummaryScore ? candidate : current;
  }

  const currentRank = sourceRank(current.source);
  const candidateRank = sourceRank(candidate.source);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank ? candidate : current;
  }

  return timestampValue(candidate.timestamp) > timestampValue(current.timestamp) ? candidate : current;
}

function preferSourceReference(current: SourceReference, candidate: SourceReference): SourceReference {
  const currentRoleRank = preferredRoleRank(current.role);
  const candidateRoleRank = preferredRoleRank(candidate.role);
  if (candidateRoleRank !== currentRoleRank) {
    return candidateRoleRank > currentRoleRank ? candidate : current;
  }

  const currentScore = (current.url ? 20 : 0) + timestampValue(current.timestamp);
  const candidateScore = (candidate.url ? 20 : 0) + timestampValue(candidate.timestamp);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  const currentRank = sourceRank(current.source);
  const candidateRank = sourceRank(candidate.source);
  return candidateRank < currentRank ? candidate : current;
}

function findOverlappingHeadlineKey<T>(items: Map<string, T>, key: string): string | undefined {
  for (const existingKey of items.keys()) {
    if (existingKey === key || existingKey.includes(key) || key.includes(existingKey)) {
      return existingKey;
    }
  }
  return undefined;
}

function dedupeThemeNewsItems(items: ThemeNewsItem[]): ThemeNewsItem[] {
  const deduped = new Map<string, ThemeNewsItem>();

  for (const item of items) {
    const key = normalizeHeadlineKey(item.headline);
    if (!key) continue;
    const overlapKey = findOverlappingHeadlineKey(deduped, key) ?? key;
    const current = deduped.get(overlapKey);
    deduped.set(overlapKey, current ? preferThemeNewsItem(current, item) : item);
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
      if (importanceDiff !== 0) return importanceDiff;
      return timestampValue(b.timestamp) - timestampValue(a.timestamp);
    })
    .slice(0, MAX_THEME_NEWS_ITEMS);
}

function dedupeSourceReferences(items: SourceReference[]): SourceReference[] {
  const deduped = new Map<string, SourceReference>();

  for (const item of items) {
    const key = sanitizeNewsUrl(item.url)
      ? `url:${sanitizeNewsUrl(item.url)}`
      : normalizeHeadlineKey(item.headline);
    if (!key) continue;
    const overlapKey = findOverlappingHeadlineKey(deduped, key) ?? key;
    const current = deduped.get(overlapKey);
    deduped.set(overlapKey, current ? preferSourceReference(current, item) : item);
  }

  return Array.from(deduped.values())
    .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp))
    .slice(0, MAX_SOURCE_REFERENCES);
}

function dedupeHeadlineStrings(items: string[], limit = MAX_PICK_SUPPORTING_NEWS): string[] {
  const deduped = new Map<string, string>();

  for (const item of items) {
    const text = asString(item);
    const key = normalizeHeadlineKey(text);
    if (!text || !key || deduped.has(key)) continue;
    deduped.set(key, text);
    if (deduped.size >= limit) break;
  }

  return Array.from(deduped.values());
}

function combineThemeEvidence(theme: Pick<TrendingTheme, "theme" | "why_it_matters" | "news_items">): string {
  return normalizeMatchText(
    [
      theme.theme,
      theme.why_it_matters ?? "",
      ...((theme.news_items ?? []).flatMap((item) => [item.headline, item.summary])),
    ].join(" ")
  );
}

function dedupeTextList(items: string[], limit = 3): string[] {
  const normalized = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const text = asString(item).trim();
    if (!text) continue;
    const key = normalizeMatchText(text);
    if (!key || normalized.has(key)) continue;
    normalized.add(key);
    deduped.push(text);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function selectThemeProcessRule(
  theme: TrendingTheme,
  xContext?: XPromptContext
): ThemeProcessRule | undefined {
  const xLabels = summarizeThemeXSupport(theme, xContext)?.labels ?? [];
  const haystack = normalizeMatchText([combineThemeEvidence(theme), ...xLabels].join(" "));
  let bestRule: ThemeProcessRule | undefined;
  let bestMatchCount = 0;

  for (const rule of THEME_PROCESS_RULES) {
    const matchCount = rule.patterns.reduce((count, pattern) => (
      pattern.test(haystack) ? count + 1 : count
    ), 0);
    if (matchCount < rule.minMatches) continue;
    if (matchCount > bestMatchCount) {
      bestRule = rule;
      bestMatchCount = matchCount;
    }
  }

  return bestRule;
}

function inferThemeBeneficiaryProcesses(
  theme: TrendingTheme,
  xContext?: XPromptContext
): string[] {
  if ((theme.beneficiary_processes ?? []).length > 0) {
    return dedupeTextList(theme.beneficiary_processes ?? [], 3);
  }

  const rule = selectThemeProcessRule(theme, xContext);
  return dedupeTextList(rule?.processes ?? [], 3);
}

function enrichThemeForInvestability(
  theme: TrendingTheme,
  xContext?: XPromptContext
): TrendingTheme {
  const rule = selectThemeProcessRule(theme, xContext);
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme, xContext);
  const needsWhyRewrite =
    !theme.why_it_matters ||
    ARTICLE_BUNDLE_THEME_PATTERNS.some((pattern) => pattern.test(combineThemeEvidence(theme))) ||
    WEAK_INVESTABLE_THEME_PATTERNS.some((pattern) => pattern.test(combineThemeEvidence(theme)));

  return {
    ...theme,
    theme: rule?.label ?? theme.theme,
    why_it_matters: needsWhyRewrite ? (rule?.why ?? theme.why_it_matters) : theme.why_it_matters,
    beneficiary_processes: beneficiaryProcesses,
  };
}

function isWeakInvestableTheme(
  theme: TrendingTheme,
  xContext?: XPromptContext
): boolean {
  const haystack = combineThemeEvidence(theme);
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme, xContext);
  const hasProcessPath = beneficiaryProcesses.length > 0;

  if (
    ARTICLE_BUNDLE_THEME_PATTERNS.some((pattern) => pattern.test(haystack)) &&
    !hasProcessPath
  ) {
    return true;
  }

  if (
    WEAK_INVESTABLE_THEME_PATTERNS.some((pattern) => pattern.test(haystack)) &&
    !hasProcessPath
  ) {
    return true;
  }

  return false;
}

function canonicalThemeLabel(theme: TrendingTheme): string {
  const haystack = combineThemeEvidence(theme);
  for (const rule of THEME_CANONICAL_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      return rule.label;
    }
  }
  return theme.theme.trim();
}

function isLowSignalTheme(theme: TrendingTheme): boolean {
  const canonical = canonicalThemeLabel(theme);
  if (canonical !== theme.theme.trim()) return false;
  const haystack = combineThemeEvidence(theme);
  return LOW_SIGNAL_THEME_PATTERNS.some((pattern) => pattern instanceof RegExp && pattern.test(haystack));
}

function isListDrivenTheme(theme: TrendingTheme): boolean {
  const haystack = combineThemeEvidence(theme);
  return LIST_DRIVEN_THEME_PATTERNS.some((pattern) => pattern.test(haystack));
}

function themeSourceCount(theme: TrendingTheme): number {
  return new Set((theme.news_items ?? []).map((item) => item.source)).size;
}

function hasNonListDrivenNews(theme: TrendingTheme): boolean {
  return (theme.news_items ?? []).some((item) => {
    const haystack = normalizeMatchText([item.headline, item.summary].join(" "));
    return !LIST_DRIVEN_THEME_PATTERNS.some((pattern) => pattern.test(haystack));
  });
}

function themeHasOnlyXEvidence(theme: TrendingTheme): boolean {
  const newsItems = theme.news_items ?? [];
  return newsItems.length > 0 && newsItems.every((item) => item.source === "x");
}

function isInterpretiveMarketItem(item: ThemeNewsItem): boolean {
  const haystack = normalizeMatchText([item.headline, item.summary].join(" "));
  return /研究|解説|考察|コラム|寄稿|特集|なぜ|新研究|実質為替レート/.test(haystack);
}

function isImmediateMarketItem(item: ThemeNewsItem): boolean {
  const haystack = normalizeMatchText([item.headline, item.summary].join(" "));
  if (item.source === "x") {
    return /原油|外為|ドル円|円安|円高|cpi|fomc|金利|雇用|iea|opec|ホルムズ|lng|速報/.test(haystack);
  }
  return /速報|市況|外為|ドル円|円安|円高|原油|金利|cpi|fomc|先物|iea|opec|ホルムズ|lng/.test(haystack);
}

function hasStrongBackdropEvidence(theme: TrendingTheme): boolean {
  const newsItems = theme.news_items ?? [];
  if (newsItems.length === 0) return false;

  const immediateNonX = newsItems.some((item) => item.source !== "x" && isImmediateMarketItem(item));
  if (immediateNonX) return true;

  const nonXCount = newsItems.filter((item) => item.source !== "x").length;
  if (nonXCount >= 2 && newsItems.some((item) => !isInterpretiveMarketItem(item))) return true;

  return false;
}

function shouldKeepTheme(theme: TrendingTheme): boolean {
  if (!isListDrivenTheme(theme)) return true;
  if (hasNonListDrivenNews(theme)) return true;

  const newsCount = (theme.news_items ?? []).length;
  const sourceCount = themeSourceCount(theme);
  return theme.mention_count >= 9 && newsCount >= 2 && sourceCount >= 2;
}

function themePriorityScore(theme: TrendingTheme): number {
  const newsCount = (theme.news_items ?? []).length;
  const sourceCount = themeSourceCount(theme);
  let score = theme.mention_count * 2 + newsCount * 2 + sourceCount;

  if (theme.why_it_matters) score += 1;
  if (isListDrivenTheme(theme)) score -= hasNonListDrivenNews(theme) ? 2 : 7;

  return score;
}

function themeIdentityKey(theme: TrendingTheme): string {
  return normalizeHeadlineKey(canonicalThemeLabel(theme));
}

function themeHeadlineKeys(theme: TrendingTheme): string[] {
  return (theme.news_items ?? [])
    .map((item) => normalizeHeadlineKey(item.headline))
    .filter(Boolean);
}

function themesSubstantiallyOverlap(a: TrendingTheme, b: TrendingTheme): boolean {
  const aKey = themeIdentityKey(a);
  const bKey = themeIdentityKey(b);
  if (aKey && bKey && (aKey === bKey || aKey.includes(bKey) || bKey.includes(aKey))) {
    return true;
  }

  const aNewsKeys = themeHeadlineKeys(a);
  const bNewsKeys = themeHeadlineKeys(b);
  return aNewsKeys.some((left) => bNewsKeys.some((right) => (
    left === right || left.includes(right) || right.includes(left)
  )));
}

function isEligibleInvestableTheme(
  theme: TrendingTheme,
  xContext?: XPromptContext
): boolean {
  const enrichedTheme = enrichThemeForInvestability(theme, xContext);
  if (isMarketBackdropTheme(enrichedTheme)) return false;

  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(enrichedTheme, xContext);
  if (beneficiaryProcesses.length === 0) return false;

  const associativeCandidateCount = findThemeRelevantCandidates(enrichedTheme, "associative", xContext)
    .filter((candidate) => scoreThemeCandidate(enrichedTheme, candidate, xContext) >= 4)
    .length;
  const xSupport = summarizeThemeXSupport(enrichedTheme, xContext);

  if (themeInvestabilityScore(enrichedTheme, xContext) < 10 && associativeCandidateCount === 0) {
    return false;
  }

  if (themeHasOnlyXEvidence(enrichedTheme)) {
    if (!xSupport || xSupport.uniqueAccounts < 2 || associativeCandidateCount === 0) {
      return false;
    }
  }

  return true;
}

function buildThemeGuidance(
  theme: TrendingTheme,
  role: "backdrop" | "investable",
  xContext?: XPromptContext
): NextCheckGuidance | undefined {
  const haystack = combineThemeEvidence(theme);
  const rule = selectThemeProcessRule(theme, xContext);
  const processes = inferThemeBeneficiaryProcesses(theme, xContext);

  if (/ドル円|ドル高|円安|米長期金利|外為|為替/.test(haystack)) {
    return {
      theme: theme.theme,
      role,
      sectors: ["外需機械", "自動車部材", "電子部品"],
      processes: ["為替感応度", "輸出採算", "受注・ガイダンス"],
      triggers: [
        "外需企業の受注・ガイダンス修正",
        "輸出比率の高い業種への需給波及",
        "為替感応度が高い企業の材料",
      ],
    };
  }

  if (/原油|中東|ホルムズ|opec|iea|lng/.test(haystack)) {
    return {
      theme: theme.theme,
      role,
      sectors: ["物流", "空運", "化学", "素材", "LNG設備"],
      processes: ["燃料費", "コスト改善", "LNG・海運保険"],
      triggers: [
        "物流・空運・化学でコスト改善を示す記事",
        "燃料費感応度の高い業種の月次・ガイダンス",
        "LNG・代替電源・海運保険への波及記事",
      ],
    };
  }

  if (/半導体|dram|nand|hbm|jx|材料投資/.test(haystack)) {
    return {
      theme: theme.theme,
      role,
      sectors: ["半導体材料", "前工程", "評価装置"],
      processes: processes.length > 0 ? processes : ["材料", "前工程", "評価装置"],
      triggers: [
        "材料・前工程・評価装置への具体波及",
        "採用先や増産計画、設備投資額の具体化",
        "関連企業の受注・提携・量産発表",
      ],
    };
  }

  if (/鉄道|パンタグラフ|ドローン|ai監視|保守dx/.test(haystack)) {
    return {
      theme: theme.theme,
      role,
      sectors: ["鉄道保守", "検査装置", "監視ソフト"],
      processes: processes.length > 0 ? processes : ["設備監視", "検査省力化", "保守ソフト"],
      triggers: [
        "採用事例・受注・提携の具体化",
        "監視ソフトやセンサーの導入先拡大",
        "鉄道保守DXの設備投資計画",
      ],
    };
  }

  if (/観光|イベント|宿泊|送客|旅客/.test(haystack)) {
    return {
      theme: theme.theme,
      role,
      sectors: ["旅行", "宿泊", "決済", "広告"],
      processes: processes.length > 0 ? processes : ["送客", "予約導線", "周辺消費"],
      triggers: [
        "イベント継続実施と収益化の確認",
        "宿泊・旅行・決済連携の具体化",
        "送客数や客単価などの定量情報",
      ],
    };
  }

  if (rule?.nextChecks?.length || processes.length > 0) {
    return {
      theme: theme.theme,
      role,
      sectors: [],
      processes,
      triggers: rule?.nextChecks?.slice(0, 3)
        ?? (processes.length > 0 ? [`${processes[0]} の受注・提携・採用事例`] : []),
    };
  }

  return undefined;
}

function buildNextCheckGuidanceFromThemes(
  marketBackdrop: TrendingTheme[],
  investableThemes: TrendingTheme[],
  xContext?: XPromptContext
): NextCheckGuidance[] {
  const guidance = [
    ...marketBackdrop.map((theme) => buildThemeGuidance(theme, "backdrop", xContext)),
    ...investableThemes.map((theme) => buildThemeGuidance(theme, "investable", xContext)),
  ].filter((item): item is NextCheckGuidance => !!item);

  const deduped = new Map<string, NextCheckGuidance>();
  for (const item of guidance) {
    const key = normalizeHeadlineKey(item.theme);
    if (!key || deduped.has(key)) continue;
    deduped.set(key, {
      ...item,
      sectors: dedupeTextList(item.sectors, 4),
      processes: dedupeTextList(item.processes, 4),
      triggers: dedupeTextList(item.triggers, 3),
    });
  }

  return Array.from(deduped.values()).slice(0, 3);
}

function buildNextChecksFromGuidance(guidance: NextCheckGuidance[]): string[] {
  const checks: string[] = [];
  for (const item of guidance) {
    const sector = item.sectors[0];
    const process = item.processes[0];
    const trigger = item.triggers[0];
    const fragments = [sector, process, trigger].filter(Boolean);
    if (fragments.length > 0) {
      checks.push(`${item.theme}: ${fragments.join(" / ")}`);
    }
  }

  if (checks.length === 0) {
    checks.push("具体波及記事・受注・提携・採用事例を確認");
  }

  return dedupeTextList(checks, MAX_NEXT_CHECKS);
}

function buildSectorWatchFromGuidance(guidance: NextCheckGuidance[]): SectorWatchItem[] {
  const deduped = new Map<string, SectorWatchItem>();

  for (const item of guidance) {
    for (const sector of item.sectors.slice(0, 2)) {
      const key = normalizeHeadlineKey(`${item.theme}:${sector}`);
      if (!key || deduped.has(key)) continue;
      deduped.set(key, {
        theme: item.theme,
        sector,
        why: `${item.theme} を受けて ${sector} の反応を確認`,
        promotion_conditions: dedupeTextList(item.triggers, 3),
      });
    }
  }

  return Array.from(deduped.values()).slice(0, 4);
}

function buildProcessWatchFromGuidance(guidance: NextCheckGuidance[]): ProcessWatchItem[] {
  const deduped = new Map<string, ProcessWatchItem>();

  for (const item of guidance) {
    for (const process of item.processes.slice(0, 2)) {
      const key = normalizeHeadlineKey(`${item.theme}:${process}`);
      if (!key || deduped.has(key)) continue;
      deduped.set(key, {
        theme: item.theme,
        process,
        focus: `${item.theme} の波及を ${process} で確認`,
        promotion_conditions: dedupeTextList(item.triggers, 3),
      });
    }
  }

  return Array.from(deduped.values()).slice(0, 4);
}

function buildAlignedMarketSentiment(result: StockAnalysisResult): string {
  const investableThemes = result.investable_themes ?? result.trending_themes;
  const backdropThemes = result.market_backdrop ?? [];
  const sectorWatch = result.sector_watch ?? [];
  const processWatch = result.process_watch ?? [];
  const associative = result.associative_picks ?? result.stock_picks;
  const watchCandidates = result.watch_candidates ?? [];

  if (investableThemes.length > 0) {
    const themeNames = investableThemes.slice(0, 2).map((theme) => theme.theme).join("、");
    const processes = dedupeTextList(
      investableThemes.flatMap((theme) => theme.beneficiary_processes ?? []),
      2
    );
    return `${themeNames} が主導。${processes.length > 0 ? `${processes.join("・")} の具体化` : "周辺工程への波及"}を見極める局面。`;
  }

  if (associative.length === 0 && watchCandidates.length === 0 && (sectorWatch.length > 0 || processWatch.length > 0)) {
    const sectors = sectorWatch.slice(0, 3).map((item) => item.sector);
    const processes = processWatch.slice(0, 2).map((item) => item.process);
    const backdropNames = backdropThemes.slice(0, 2).map((theme) => theme.theme).join("、");
    const focus = dedupeTextList([...sectors, ...processes], 3).join("・");
    return `背景相場中心。${backdropNames || "マクロ材料"}を踏まえ、${focus || "業種・工程"}の具体波及待ち。`;
  }

  if (watchCandidates.length > 0) {
    const watchNames = watchCandidates.slice(0, 2).map((pick) => pick.name).join("、");
    return `${watchNames} を中心に確認。テーマの具体化はまだ途上で、受注・提携・採用事例の確認が必要。`;
  }

  if (backdropThemes.length > 0) {
    return `${backdropThemes.slice(0, 2).map((theme) => theme.theme).join("、")}が相場の主因。具体テーマ化は続報待ち。`;
  }

  return result.market_sentiment || "市場観測なし";
}

function preferWhyText(current?: string, candidate?: string): string | undefined {
  const currentText = asString(current);
  const candidateText = asString(candidate);
  if (!currentText) return candidateText || undefined;
  if (!candidateText) return currentText || undefined;
  return candidateText.length > currentText.length ? candidateText : currentText;
}

function normalizeAndMergeThemes(themes: TrendingTheme[]): TrendingTheme[] {
  const merged = new Map<string, TrendingTheme>();

  for (const theme of themes) {
    const normalizedTheme: TrendingTheme = {
      ...theme,
      theme: canonicalThemeLabel(theme),
      key_tweets: dedupeHeadlineStrings(theme.key_tweets, MAX_THEME_KEY_TWEETS),
      news_items: dedupeThemeNewsItems(theme.news_items ?? []),
    };
    if (!normalizedTheme.theme || isLowSignalTheme(normalizedTheme)) continue;

    const key = normalizeHeadlineKey(normalizedTheme.theme);
    const current = merged.get(key);

    if (!current) {
      merged.set(key, normalizedTheme);
      continue;
    }

    merged.set(key, {
      theme: normalizedTheme.theme,
      mention_count: current.mention_count + normalizedTheme.mention_count,
      key_tweets: dedupeHeadlineStrings(
        [...current.key_tweets, ...normalizedTheme.key_tweets],
        MAX_THEME_KEY_TWEETS
      ),
      why_it_matters: preferWhyText(current.why_it_matters, normalizedTheme.why_it_matters),
      news_items: dedupeThemeNewsItems([
        ...(current.news_items ?? []),
        ...(normalizedTheme.news_items ?? []),
      ]),
    });
  }

  return Array.from(merged.values())
    .filter((theme) => shouldKeepTheme(theme))
    .sort((a, b) => {
      const priorityDiff = themePriorityScore(b) - themePriorityScore(a);
      if (priorityDiff !== 0) return priorityDiff;
      const mentionDiff = b.mention_count - a.mention_count;
      if (mentionDiff !== 0) return mentionDiff;
      return timestampValue(b.news_items?.[0]?.timestamp) - timestampValue(a.news_items?.[0]?.timestamp);
    })
    .slice(0, MAX_THEME_COUNT);
}

function parseThemeNewsItems(value: unknown): ThemeNewsItem[] {
  if (!Array.isArray(value)) return [];
  const items: ThemeNewsItem[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const headline = pickString(record, "headline", "h");
    if (!headline) continue;

    items.push({
      headline,
      summary: truncate(pickString(record, "summary", "sum"), MAX_THEME_SUMMARY_LEN),
      source: normalizeSource(record.source ?? record.src),
      url: sanitizeNewsUrl(pickString(record, "url", "u") || undefined),
      timestamp: pickString(record, "timestamp", "ts") || undefined,
      importance: asImportance(record.importance ?? record.i),
    });
  }

  return dedupeThemeNewsItems(items);
}

function parseSourceList(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) return [];
  const items: SourceReference[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const headline = pickString(record, "headline", "h");
    if (!headline) continue;

    items.push({
      source: normalizeSource(record.source ?? record.src),
      headline,
      url: sanitizeNewsUrl(pickString(record, "url", "u") || undefined),
      timestamp: pickString(record, "timestamp", "ts") || undefined,
    });
  }

  return dedupeSourceReferences(items);
}

function inputHeadlineKey(tweet: Tweet): string {
  return normalizeHeadlineKey(tweet.headline ?? tweet.text);
}

function findMatchingInputPost(
  headline: string,
  source: ThemeNewsItem["source"] | SourceReference["source"],
  tweets: Tweet[]
): Tweet | undefined {
  const key = normalizeHeadlineKey(headline);
  if (!key) return undefined;

  return tweets
    .filter((tweet) => {
      if (tweet.source !== source) return false;
      const tweetKey = inputHeadlineKey(tweet);
      return !!tweetKey && (tweetKey === key || tweetKey.includes(key) || key.includes(tweetKey));
    })
    .sort((a, b) => {
      const urlDiff = Number(!!sanitizeNewsUrl(b.url)) - Number(!!sanitizeNewsUrl(a.url));
      if (urlDiff !== 0) return urlDiff;
      return timestampValue(b.timestamp) - timestampValue(a.timestamp);
    })[0];
}

function hydrateThemeNewsItemsFromInputs(items: ThemeNewsItem[], tweets: Tweet[]): ThemeNewsItem[] {
  return dedupeThemeNewsItems(items.map((item) => {
    const match = findMatchingInputPost(item.headline, item.source, tweets);
    return {
      ...item,
      url: sanitizeNewsUrl(item.url) ?? sanitizeNewsUrl(match?.url),
      timestamp: item.timestamp ?? match?.timestamp,
    };
  }));
}

function hydrateSourceReferencesFromInputs(items: SourceReference[], tweets: Tweet[]): SourceReference[] {
  return dedupeSourceReferences(items.map((item) => {
    const match = findMatchingInputPost(item.headline, item.source, tweets);
    return {
      ...item,
      url: sanitizeNewsUrl(item.url) ?? sanitizeNewsUrl(match?.url),
      timestamp: item.timestamp ?? match?.timestamp,
    };
  }));
}

function hydrateThemeFromInputs(theme: TrendingTheme, tweets: Tweet[]): TrendingTheme {
  return {
    ...theme,
    news_items: hydrateThemeNewsItemsFromInputs(theme.news_items ?? [], tweets),
  };
}

function buildUsedSourceReferences(
  marketBackdrop: TrendingTheme[],
  investableThemes: TrendingTheme[],
  guidance: NextCheckGuidance[] = [],
  noIdeaDay = false
): SourceReference[] {
  const guidanceMap = new Map(guidance.map((item) => [normalizeHeadlineKey(item.theme), item]));
  return [
    ...marketBackdrop.flatMap((theme) => (
      theme.news_items ?? []
    ).slice(0, 1).map((item) => ({
      source: item.source,
      headline: item.headline,
      url: item.url,
      timestamp: item.timestamp,
      role: (
        noIdeaDay
          ? (guidanceMap.get(normalizeHeadlineKey(theme.theme))?.sectors?.length
              ? "sector_watch"
              : guidanceMap.get(normalizeHeadlineKey(theme.theme))?.processes?.length
                ? "process_watch"
                : "backdrop")
          : "backdrop"
      ) as SourceReference["role"],
      theme: theme.theme,
    }))),
    ...investableThemes.flatMap((theme) => (
      theme.news_items ?? []
    ).map((item) => ({
      source: item.source,
      headline: item.headline,
      url: item.url,
      timestamp: item.timestamp,
      role: "investable" as const,
      theme: theme.theme,
    }))),
  ];
}

function hydrateAnalysisSources(result: StockAnalysisResult, tweets: Tweet[]): StockAnalysisResult {
  const marketBackdrop = (result.market_backdrop ?? []).map((theme) => hydrateThemeFromInputs(theme, tweets));
  const investableThemes = (result.investable_themes ?? []).map((theme) => hydrateThemeFromInputs(theme, tweets));
  const trendingThemes = result.trending_themes.map((theme) => hydrateThemeFromInputs(theme, tweets));
  const noIdeaDay =
    (result.direct_picks ?? []).length === 0 &&
    (result.associative_picks ?? result.stock_picks).length === 0 &&
    (result.watch_candidates ?? []).length === 0;
  const sourceSeed = buildUsedSourceReferences(
    marketBackdrop,
    investableThemes,
    result.next_check_guidance ?? [],
    noIdeaDay
  );

  const hydratedResult = {
    ...result,
    market_backdrop: marketBackdrop,
    investable_themes: investableThemes,
    trending_themes: trendingThemes,
    source_list: hydrateSourceReferencesFromInputs(sourceSeed, tweets),
  };

  return {
    ...hydratedResult,
    market_sentiment: buildAlignedMarketSentiment(hydratedResult),
  };
}

type ListedStockCandidate = {
  code: string;
  name: string;
  keywords: string[];
};

const STOCK_FALLBACK_CANDIDATES: ListedStockCandidate[] = [
  { code: "4593", name: "ヘリオス", keywords: ["ips", "再生医療", "幹細胞", "細胞治療"] },
  { code: "4592", name: "サンバイオ", keywords: ["再生医療", "細胞治療", "幹細胞"] },
  { code: "9020", name: "東日本旅客鉄道", keywords: ["山手線", "パンタグラフ", "鉄道設備監視", "ドローン", "保守"] },
  { code: "9142", name: "九州旅客鉄道", keywords: ["jr九州", "特急列車", "宿泊イベント", "観光送客", "旅客サービス"] },
  { code: "2477", name: "手間いらず", keywords: ["宿泊連携", "宿泊予約", "ホテル", "観光送客", "旅客サービス"] },
  { code: "6030", name: "アドベンチャー", keywords: ["旅行予約", "観光送客", "旅客サービス", "宿泊", "周辺消費"] },
  { code: "9722", name: "藤田観光", keywords: ["宿泊", "観光消費", "ホテル", "イベント", "周辺消費"] },
  { code: "4186", name: "東京応化工業", keywords: ["半導体材料", "レジスト", "前工程", "euv", "高機能素材"] },
  { code: "4980", name: "デクセリアルズ", keywords: ["半導体材料", "電子材料", "接合材料", "ディスプレイ", "車載"] },
  { code: "8035", name: "東京エレクトロン", keywords: ["半導体", "euv", "hbm", "半導体製造装置", "先端半導体", "ロジック", "dram", "nand", "メモリ"] },
  { code: "6857", name: "アドバンテスト", keywords: ["半導体", "テスタ", "hbm", "ai半導体", "gpu", "dram", "メモリ"] },
  { code: "6920", name: "レーザーテック", keywords: ["半導体", "euv", "マスク", "検査装置", "メモリ"] },
  { code: "7735", name: "SCREENホールディングス", keywords: ["半導体", "洗浄装置", "半導体製造装置", "dram", "nand"] },
  { code: "6146", name: "ディスコ", keywords: ["半導体", "切断", "研削", "後工程"] },
  { code: "6723", name: "ルネサスエレクトロニクス", keywords: ["半導体", "自動車半導体", "マイコン"] },
  { code: "6740", name: "ジャパンディスプレイ", keywords: ["jdi", "ディスプレイ", "新工場", "対米投融資", "液晶"] },
  { code: "6503", name: "三菱電機", keywords: ["鉄道設備監視", "制御システム", "検査省力化", "保守ソフト", "インフラ監視"] },
  { code: "6946", name: "日本アビオニクス", keywords: ["画像監視", "赤外線", "ドローン点検", "センサー", "監視"] },
  { code: "7011", name: "三菱重工業", keywords: ["防衛", "ミサイル", "安全保障", "造船", "原子力"] },
  { code: "7012", name: "川崎重工業", keywords: ["防衛", "潜水艦", "航空機", "水素"] },
  { code: "7013", name: "IHI", keywords: ["防衛", "航空エンジン", "宇宙"] },
  { code: "4704", name: "トレンドマイクロ", keywords: ["サイバー", "セキュリティ", "不正アクセス", "ゼロデイ"] },
  { code: "6701", name: "NEC", keywords: ["サイバー", "防衛", "政府システム", "dx"] },
  { code: "6702", name: "富士通", keywords: ["サイバー", "行政", "システム", "ai"] },
  { code: "5801", name: "古河電気工業", keywords: ["データセンター", "光ファイバー", "電線", "電力網"] },
  { code: "5805", name: "SWCC", keywords: ["データセンター", "電線", "電力ケーブル", "送配電"] },
  { code: "6501", name: "日立製作所", keywords: ["電力", "インフラ", "データセンター", "dx", "送配電"] },
  { code: "1605", name: "INPEX", keywords: ["原油", "天然ガス", "エネルギー", "opec", "中東"] },
  { code: "5020", name: "ENEOSホールディングス", keywords: ["原油", "製油", "ガソリン", "エネルギー"] },
  { code: "1963", name: "日揮ホールディングス", keywords: ["lng", "エネルギー設備", "プラント", "代替電源", "資源開発"] },
  { code: "6366", name: "千代田化工建設", keywords: ["lng", "プラント", "エネルギー設備", "代替電源", "資源開発"] },
  { code: "8766", name: "東京海上ホールディングス", keywords: ["海運保険", "輸送保険", "資源輸送", "地政学", "保険"] },
  { code: "9101", name: "日本郵船", keywords: ["海運", "ホルムズ", "コンテナ", "物流"] },
  { code: "9104", name: "商船三井", keywords: ["海運", "原油輸送", "ホルムズ", "物流"] },
  { code: "9107", name: "川崎汽船", keywords: ["海運", "物流", "コンテナ", "航路"] },
  { code: "8306", name: "三菱UFJフィナンシャル・グループ", keywords: ["金利", "銀行", "長期金利", "利ざや"] },
  { code: "8316", name: "三井住友フィナンシャルグループ", keywords: ["金利", "銀行", "金融"] },
];

const SUPPLEMENTAL_STOCK_FALLBACK_CANDIDATES: ListedStockCandidate[] = [
  { code: "6723", name: "ルネサスエレクトロニクス", keywords: ["toyota", "nvidia", "worldmodel", "adas", "車載半導体", "マイコン"] },
  { code: "6902", name: "デンソー", keywords: ["toyota", "nvidia", "worldmodel", "自動車", "adas", "車載", "モビリティai"] },
];
const ALL_STOCK_FALLBACK_CANDIDATES = [
  ...STOCK_FALLBACK_CANDIDATES,
  ...SUPPLEMENTAL_STOCK_FALLBACK_CANDIDATES,
];

function normalizeMatchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function isPlaceholderStockCode(code: string): boolean {
  return !/^\d{4}$/.test(code) || code === "0000";
}

function isPlaceholderStockName(name: string): boolean {
  if (!name) return true;
  return /代表例|関連株|銘柄候補|候補株|有力株|未定|不明|generic|example/i.test(name);
}

function findThemeForPick(pick: StockPick, themes: TrendingTheme[]): TrendingTheme | undefined {
  const haystack = normalizeMatchText(
    [
      pick.root_theme ?? "",
      pick.chain,
      pick.reasoning,
      pick.catalyst,
      ...(pick.supporting_news ?? []),
    ].join(" ")
  );
  return themes.find((theme) => {
    const normalizedTheme = normalizeMatchText(theme.theme);
    return !!normalizedTheme && haystack.includes(normalizedTheme);
  });
}

function findListedCandidateByCode(code: string): ListedStockCandidate | undefined {
  return ALL_STOCK_FALLBACK_CANDIDATES.find((candidate) => candidate.code === code);
}

function findListedCandidateForPick(code: string, name: string): ListedStockCandidate | undefined {
  const byCode = findListedCandidateByCode(code);
  if (byCode) return byCode;
  const normalizedName = normalizeMatchText(name);
  if (!normalizedName) return undefined;
  return ALL_STOCK_FALLBACK_CANDIDATES.find((candidate) =>
    normalizeMatchText(candidate.name) === normalizedName
  );
}

function candidateMentionedInThemeEvidence(theme: TrendingTheme, candidate: ListedStockCandidate): boolean {
  const evidenceText = normalizeMatchText(
    [
      theme.theme,
      theme.why_it_matters ?? "",
      ...((theme.news_items ?? []).flatMap((item) => [item.headline, item.summary])),
    ].join(" ")
  );
  return evidenceText.includes(candidate.code) || evidenceText.includes(normalizeMatchText(candidate.name));
}

function candidateBenefitTypeForTheme(
  theme: TrendingTheme,
  candidate: ListedStockCandidate,
  xContext?: XPromptContext
): "origin" | "primary" | "peripheral" {
  const rule = selectThemeProcessRule(theme, xContext);
  if (rule?.associativeCodes?.includes(candidate.code)) return "peripheral";
  if (rule?.watchCodes?.includes(candidate.code)) {
    return candidateMentionedInThemeEvidence(theme, candidate) ? "origin" : "primary";
  }
  return candidateMentionedInThemeEvidence(theme, candidate) ? "origin" : "peripheral";
}

function candidateBenefitPriority(type: "origin" | "primary" | "peripheral"): number {
  switch (type) {
    case "peripheral":
      return 0;
    case "primary":
      return 1;
    default:
      return 2;
  }
}

function isPreferredPeripheralCandidate(
  theme: TrendingTheme,
  candidate: ListedStockCandidate,
  xContext?: XPromptContext
): boolean {
  const rule = selectThemeProcessRule(theme, xContext);
  return candidateBenefitTypeForTheme(theme, candidate, xContext) === "peripheral" &&
    !!rule?.associativeCodes?.includes(candidate.code);
}

function describeBenefitType(
  type?: "origin" | "primary" | "peripheral"
): string | undefined {
  switch (type) {
    case "origin":
      return "当事者監視";
    case "primary":
      return "一次受益監視";
    case "peripheral":
      return "周辺工程候補";
    default:
      return undefined;
  }
}

function findFallbackStockCandidate(
  pick: StockPick,
  themes: TrendingTheme[]
): { candidate: ListedStockCandidate; score: number } | undefined {
  const relatedTheme = findThemeForPick(pick, themes);
  if (!relatedTheme) return undefined;
  const haystack = normalizeMatchText(
    [
      pick.root_theme ?? "",
      pick.chain,
      pick.reasoning,
      pick.catalyst,
      ...(pick.supporting_news ?? []),
      relatedTheme?.theme ?? "",
      relatedTheme?.why_it_matters ?? "",
      ...((relatedTheme?.news_items ?? []).flatMap((item) => [item.headline, item.summary])),
    ].join(" ")
  );

  let best: ListedStockCandidate | undefined;
  let bestScore = 0;

  for (const candidate of ALL_STOCK_FALLBACK_CANDIDATES) {
    const score = candidate.keywords.reduce((sum, keyword) => (
      haystack.includes(normalizeMatchText(keyword)) ? sum + 1 : sum
    ), 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best && bestScore >= 2 ? { candidate: best, score: bestScore } : undefined;
}

function findThemeRelevantCandidates(
  theme: TrendingTheme,
  mode: "all" | "associative" | "watch" = "all",
  xContext?: XPromptContext
): ListedStockCandidate[] {
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme);
  const processHaystack = normalizeMatchText([
    theme.theme,
    ...beneficiaryProcesses,
  ].join(" "));
  const evidenceHaystack = combineThemeEvidence(theme);
  const rule = selectThemeProcessRule(theme, xContext);
  const priorityCodes = dedupeTextList([
    ...(rule?.associativeCodes ?? []),
    ...(mode === "watch" || mode === "all" ? (rule?.watchCodes ?? []) : []),
  ], 12);

  const prioritized = priorityCodes
    .map((code) => findListedCandidateByCode(code))
    .filter((candidate): candidate is ListedStockCandidate => !!candidate);

  const matched = ALL_STOCK_FALLBACK_CANDIDATES.filter((candidate) => {
    if (beneficiaryProcesses.length > 0) {
      return candidate.keywords.some((keyword) => processHaystack.includes(normalizeMatchText(keyword)));
    }
    return candidate.keywords.some((keyword) => evidenceHaystack.includes(normalizeMatchText(keyword)));
  });

  const merged = [...prioritized, ...matched].filter((candidate, index, array) =>
    array.findIndex((item) => item.code === candidate.code) === index
  );

  if (mode === "associative") {
    return merged.filter((candidate) => candidateBenefitTypeForTheme(theme, candidate, xContext) === "peripheral");
  }

  if (mode === "watch") {
    return merged.sort((a, b) => {
      const typeDiff =
        candidateBenefitPriority(candidateBenefitTypeForTheme(theme, a, xContext)) -
        candidateBenefitPriority(candidateBenefitTypeForTheme(theme, b, xContext));
      if (typeDiff !== 0) return typeDiff;
      return scoreThemeCandidate(theme, b, xContext) - scoreThemeCandidate(theme, a, xContext);
    });
  }

  return merged;
}

function normalizeHeadlineOverlap(text: string, candidates: string[]): boolean {
  const normalized = normalizeHeadlineKey(text);
  if (!normalized) return false;
  return candidates.some((candidate) => {
    const key = normalizeHeadlineKey(candidate);
    return !!key && (normalized.includes(key) || key.includes(normalized));
  });
}

function pickRelevanceScore(
  pick: StockPick,
  relatedTheme: TrendingTheme | undefined,
  supportingNews: string[]
): number {
  if (!relatedTheme) return 0;

  let score = 0;
  const haystack = normalizeMatchText(
    [pick.chain, pick.reasoning, pick.catalyst, pick.root_theme ?? "", ...supportingNews].join(" ")
  );
  const themeKey = normalizeMatchText(relatedTheme.theme);
  const themeNews = (relatedTheme.news_items ?? []).map((item) => item.headline);

  if (pick.root_theme && normalizeMatchText(pick.root_theme).includes(themeKey)) score += 2;
  if (themeKey && haystack.includes(themeKey)) score += 1;
  if (supportingNews.length > 0 && normalizeHeadlineOverlap(supportingNews.join(" "), themeNews)) score += 2;
  if ((relatedTheme.news_items ?? []).length > 0 && supportingNews.length > 0) score += 1;
  if (/->|→/.test(pick.chain)) score += 1;

  return score;
}

function pickMatchesThemeCandidates(
  pick: StockPick,
  candidates: ListedStockCandidate[]
): boolean {
  const normalizedName = normalizeMatchText(pick.name);
  return candidates.some((candidate) =>
    candidate.code === pick.code || normalizedName.includes(normalizeMatchText(candidate.name))
  );
}

function pickBusinessKeywordScore(
  pick: StockPick,
  candidates: ListedStockCandidate[]
): number {
  const businessText = normalizeMatchText([pick.chain, pick.reasoning, pick.catalyst].join(" "));
  let score = 0;

  for (const candidate of candidates) {
    for (const keyword of candidate.keywords) {
      if (businessText.includes(normalizeMatchText(keyword))) score += 1;
    }
  }

  return score;
}

function pickMentionedInThemeEvidence(
  code: string,
  name: string,
  relatedTheme: TrendingTheme,
  supportingNews: string[]
): boolean {
  const evidenceText = normalizeMatchText(
    [
      relatedTheme.theme,
      relatedTheme.why_it_matters ?? "",
      ...supportingNews,
      ...((relatedTheme.news_items ?? []).flatMap((item) => [item.headline, item.summary])),
    ].join(" ")
  );
  const normalizedName = normalizeMatchText(name);
  return (!!normalizedName && evidenceText.includes(normalizedName)) || (!!code && evidenceText.includes(code));
}

function scoreThemeCandidate(
  theme: TrendingTheme,
  candidate: ListedStockCandidate,
  xContext?: XPromptContext
): number {
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme, xContext);
  const evidenceHaystack = combineThemeEvidence(theme);
  const processHaystack = normalizeMatchText([theme.theme, ...beneficiaryProcesses].join(" "));
  const rule = selectThemeProcessRule(theme, xContext);
  return candidate.keywords.reduce((score, keyword) => {
    const normalizedKeyword = normalizeMatchText(keyword);
    if (beneficiaryProcesses.length > 0) {
      if (processHaystack.includes(normalizedKeyword)) return score + 2;
      if (evidenceHaystack.includes(normalizedKeyword)) return score + 0.5;
      return score;
    }
    if (evidenceHaystack.includes(normalizedKeyword)) return score + 1;
    return score;
  }, 0)
    + (rule?.associativeCodes?.includes(candidate.code) ? 2 : 0)
    + (rule?.watchCodes?.includes(candidate.code) ? 1 : 0);
}

function matchedThemeCandidateKeywords(theme: TrendingTheme, candidate: ListedStockCandidate): string[] {
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme);
  const haystack = normalizeMatchText(
    beneficiaryProcesses.length > 0
      ? [theme.theme, ...beneficiaryProcesses].join(" ")
      : combineThemeEvidence(theme)
  );
  const seen = new Set<string>();

  for (const keyword of candidate.keywords) {
    if (haystack.includes(normalizeMatchText(keyword))) {
      seen.add(keyword);
    }
  }

  return Array.from(seen);
}

function hasStrongThemeCandidateLink(theme: TrendingTheme, candidate: ListedStockCandidate): boolean {
  const matchedKeywords = matchedThemeCandidateKeywords(theme, candidate);
  if (matchedKeywords.length < 2) return false;

  const headlineMatch = (theme.news_items ?? []).some((item) => {
    const haystack = normalizeMatchText([item.headline, item.summary].join(" "));
    return matchedKeywords.some((keyword) => haystack.includes(normalizeMatchText(keyword)));
  });

  return headlineMatch || themeSourceCount(theme) >= 2;
}

function buildSynthesizedPickNarrative(
  theme: TrendingTheme,
  candidate: ListedStockCandidate,
  xContext?: XPromptContext
): Pick<StockPick, "chain" | "reasoning" | "catalyst" | "supporting_news"> {
  const matchedKeywords = matchedThemeCandidateKeywords(theme, candidate).slice(0, 2);
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme).slice(0, 2);
  const benefitType = candidateBenefitTypeForTheme(theme, candidate, xContext);
  const cueNewsItem = (theme.news_items ?? []).find((item) => {
    const haystack = normalizeMatchText([item.headline, item.summary].join(" "));
    return matchedKeywords.some((keyword) => haystack.includes(normalizeMatchText(keyword)));
  }) ?? theme.news_items?.[0];
  const cueNews = cueNewsItem?.headline;
  const keywordText = matchedKeywords.join("・");
  const processText = beneficiaryProcesses.join(" -> ");
  const businessText = keywordText || candidate.keywords.slice(0, 2).join("・");

  return {
    chain: processText
      ? `${theme.theme} -> ${processText} -> ${candidate.name}の関連事業`
      : keywordText
        ? `${theme.theme} -> ${keywordText}関連需要 -> ${candidate.name}の関連事業`
        : `${theme.theme} -> ${candidate.name}の関連事業`,
    reasoning: benefitType === "peripheral"
      ? cueNews
        ? `${cueNews}を起点に、当事者そのものではなく${processText || keywordText || theme.theme}の工程へ波及したとき、${candidate.name}の${businessText || "関連事業"}が恩恵を受けやすいため。`
        : `${theme.theme}から${processText || keywordText || "受益工程"}を経由したとき、${candidate.name}の${businessText || "関連事業"}が周辺受益として繋がりやすいため。`
      : cueNews
        ? `${cueNews}の進展を確認する上で、${candidate.name}は${processText || keywordText || theme.theme}の当事者/一次受益として追いやすいため。`
        : `${theme.theme}の進展を確認する上で、${candidate.name}は${processText || keywordText || "受益工程"}の一次受益として追いやすいため。`,
    catalyst: processText
      ? `${beneficiaryProcesses[0]}の受注・提携・設備投資計画の具体化`
      : cueNews ?? theme.theme,
    supporting_news: cueNews ? [cueNews] : [],
  };
}

function synthesizePicksFromThemes(themes: TrendingTheme[]): StockPick[] {
  const synthesized: StockPick[] = [];
  const seenCodes = new Set<string>();

  for (const theme of themes) {
    if (isListDrivenTheme(theme)) continue;

    const candidate = findThemeRelevantCandidates(theme, "associative")
      .map((item) => ({ item, score: scoreThemeCandidate(theme, item) }))
      .filter(({ score, item }) => score >= 2 && !seenCodes.has(item.code))
      .sort((a, b) => b.score - a.score)[0];

    if (!candidate) continue;

    const cueNews = theme.news_items?.[0]?.headline;
    seenCodes.add(candidate.item.code);
    synthesized.push({
      rank: synthesized.length + 1,
      code: candidate.item.code,
      name: candidate.item.name,
      chain: `${theme.theme} -> ${candidate.item.name}の関連事業へ需要・物色が波及`,
      reasoning: `${theme.theme}と事業キーワードの重なりが比較的明確で、直接受益の説明がしやすい。`,
      confidence: Math.min(6, Math.max(5, candidate.score + 3)),
      risk: "テーマの継続性が弱いと物色が短命に終わる可能性がある。",
      catalyst: cueNews ?? theme.theme,
      root_theme: theme.theme,
      supporting_news: cueNews ? [cueNews] : [],
      benefit_type: "peripheral",
    });

    if (synthesized.length >= 2) break;
  }

  return synthesized;
}

function synthesizePicksFromThemesStrict(themes: TrendingTheme[]): StockPick[] {
  const synthesized: StockPick[] = [];
  const seenCodes = new Set<string>();

  for (const theme of themes) {
    if (isListDrivenTheme(theme)) continue;

    const candidate = findThemeRelevantCandidates(theme, "associative")
      .map((item) => ({
        item,
        score: scoreThemeCandidate(theme, item),
        matchedKeywords: matchedThemeCandidateKeywords(theme, item),
      }))
      .filter(({ score, item, matchedKeywords }) => (
        score >= 3 &&
        (matchedKeywords.length >= 2 || (isPreferredPeripheralCandidate(theme, item) && score >= 4)) &&
        (hasStrongThemeCandidateLink(theme, item) || isPreferredPeripheralCandidate(theme, item)) &&
        !seenCodes.has(item.code)
      ))
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return b.matchedKeywords.length - a.matchedKeywords.length;
      })[0];

    if (!candidate) continue;

    const narrative = buildSynthesizedPickNarrative(theme, candidate.item);
    seenCodes.add(candidate.item.code);
    synthesized.push({
      rank: synthesized.length + 1,
      code: candidate.item.code,
      name: candidate.item.name,
      chain: narrative.chain,
      reasoning: narrative.reasoning,
      confidence: Math.min(6, Math.max(5, candidate.score + 3)),
      risk: "テーマ進展が一過性なら物色が続かず、業績への波及も限定的になりうる。",
      catalyst: narrative.catalyst,
      root_theme: theme.theme,
      supporting_news: narrative.supporting_news,
      benefit_type: "peripheral",
    });

    if (synthesized.length >= 2) break;
  }

  return synthesized;
}

function inferWatchCatalyst(theme: TrendingTheme, candidate: ListedStockCandidate): string {
  const haystack = combineThemeEvidence(theme);
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme);

  if (beneficiaryProcesses.length > 0) {
    return `${beneficiaryProcesses[0]}の受注・提携・設備投資計画の具体化`;
  }

  if (/原油|天然ガス|opec|中東/.test(haystack)) {
    return "原油価格の継続上昇や供給不安の長期化";
  }
  if (/ips|再生医療|幹細胞|細胞治療/.test(haystack)) {
    return "承認後の提携・治験進展や関連企業への波及";
  }
  if (/防衛|安全保障|ミサイル|航空/.test(haystack)) {
    return "政策・予算・受注の具体化";
  }
  if (/データセンター|光ファイバー|送配電|電線/.test(haystack)) {
    return "受注拡大や設備投資計画の具体化";
  }
  if (/usdc|circle|ステーブルコイン|決済/.test(haystack)) {
    return "国内企業の導入・提携や規制進展";
  }

  const cueNews = theme.news_items?.[0]?.headline;
  if (cueNews) {
    return truncate(cueNews, 60);
  }
  return `${candidate.name}の関連事業に結び付く追加材料`;
}

function synthesizeWatchCandidatesFromThemes(
  themes: TrendingTheme[],
  xContext?: XPromptContext,
  debugLogs: string[] = []
): StockPick[] {
  const watchCandidates: StockPick[] = [];
  const seenCodes = new Set<string>();

  for (const theme of themes) {
    if (isListDrivenTheme(theme)) {
      if (ANALYZER_DEBUG_X) debugLogs.push(`drop:${theme.theme}: list-driven theme`);
      continue;
    }

    const xSupport = summarizeThemeXSupport(theme, xContext);
    const xOnlyTheme = themeHasOnlyXEvidence(theme);
    const beneficiaryProcesses = inferThemeBeneficiaryProcesses(theme, xContext);

    if (!xOnlyTheme && beneficiaryProcesses.length === 0) {
      if (ANALYZER_DEBUG_X) debugLogs.push(`drop:${theme.theme}: no beneficiary process path`);
      continue;
    }

    const candidates = findThemeRelevantCandidates(theme, "watch", xContext)
      .map((item) => ({
        item,
        score: scoreThemeCandidate(theme, item, xContext),
        matchedKeywords: matchedThemeCandidateKeywords(theme, item),
      }))
      .filter(({ score, item, matchedKeywords }) => (
        score >= 2 &&
        matchedKeywords.length >= 1 &&
        !seenCodes.has(item.code) &&
        (
          !xOnlyTheme
            ? beneficiaryProcesses.length >= 1 &&
              (
                hasStrongThemeCandidateLink(theme, item) ||
                matchedKeywords.length >= 2 ||
                (isPreferredPeripheralCandidate(theme, item, xContext) && score >= 4)
              )
            : !!xSupport &&
              (xSupport.uniqueAccounts >= 2 || xSupport.supportScore >= 8.5) &&
              beneficiaryProcesses.length >= 1 &&
              matchedKeywords.length >= 2 &&
              score >= 3
        )
      ))
      .sort((a, b) => {
        const typeDiff =
          candidateBenefitPriority(candidateBenefitTypeForTheme(theme, a.item, xContext)) -
          candidateBenefitPriority(candidateBenefitTypeForTheme(theme, b.item, xContext));
        if (typeDiff !== 0) return typeDiff;
        const aBoost = xOnlyTheme ? (xSupport?.supportScore ?? 0) : 0;
        const bBoost = xOnlyTheme ? (xSupport?.supportScore ?? 0) : 0;
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        const keywordDiff = b.matchedKeywords.length - a.matchedKeywords.length;
        if (keywordDiff !== 0) return keywordDiff;
        return bBoost - aBoost;
      })
      .slice(0, xOnlyTheme ? 1 : 2);

    if (candidates.length === 0) {
      if (ANALYZER_DEBUG_X) {
        if (xOnlyTheme && xSupport) {
          debugLogs.push(
            `drop:${theme.theme}: x-only support weak for watch ` +
            `(clusters=${xSupport.clusterCount}, accounts=${xSupport.uniqueAccounts}, score=${xSupport.supportScore})`
          );
        } else if (xOnlyTheme) {
          debugLogs.push(`drop:${theme.theme}: x-only theme without usable cluster support`);
        }
      }
      continue;
    }

    for (const [index, candidate] of candidates.entries()) {
      if (seenCodes.has(candidate.item.code)) continue;
      const benefitType = candidateBenefitTypeForTheme(theme, candidate.item, xContext);
      const narrative = buildSynthesizedPickNarrative(theme, candidate.item, xContext);
      seenCodes.add(candidate.item.code);
      watchCandidates.push({
        rank: watchCandidates.length + 1,
        code: candidate.item.code,
        name: candidate.item.name,
        chain: narrative.chain,
        reasoning: xOnlyTheme && xSupport
          ? `${narrative.reasoning} Xで同系統観測が${xSupport.uniqueAccounts}アカウントから出ているが、他ソース裏付けはまだ薄いため監視候補に留める。`
          : `${narrative.reasoning} 現時点では直接受益の確度はまだ高くないため監視候補に留める。`,
        confidence: xOnlyTheme && xSupport
          ? Math.min(5, Math.max(3, Math.round(candidate.score + xSupport.uniqueAccounts / 2) - index))
          : Math.min(4, Math.max(3, candidate.score + 1 - index)),
        risk: xOnlyTheme
          ? "X起点の仮説段階で、IR・受注・業績寄与の裏付けがまだ不足している。"
          : "事業接続はあるが、受注・提携・業績寄与の裏付けがまだ弱い。",
        catalyst: inferWatchCatalyst(theme, candidate.item),
        root_theme: theme.theme,
        supporting_news: narrative.supporting_news,
        benefit_type: benefitType,
      });
      if (ANALYZER_DEBUG_X) {
        debugLogs.push(
          `keep:${theme.theme}: ${candidate.item.name}(${candidate.item.code}) ` +
          `keywords=${candidate.matchedKeywords.length} score=${candidate.score}` +
          ` process=${beneficiaryProcesses.join("/") || "-"}` +
          (xSupport
            ? ` xclusters=${xSupport.clusterCount} xaccounts=${xSupport.uniqueAccounts} xscore=${xSupport.supportScore}`
            : "")
        );
      }
      if (watchCandidates.length >= MAX_WATCH_CANDIDATES) break;
    }

    if (watchCandidates.length >= MAX_WATCH_CANDIDATES) break;
  }

  return watchCandidates;
}

function normalizeStockPicks(
  stockPicks: StockPick[],
  themes: TrendingTheme[],
  sources: SourceReference[]
): StockPick[] {
  const normalized: StockPick[] = [];
  const seenCodes = new Set<string>();

  for (const pick of stockPicks) {
    const relatedTheme = findThemeForPick(pick, themes);
    const fallback = findFallbackStockCandidate(pick, themes);
    const code = isPlaceholderStockCode(pick.code) ? (fallback?.candidate.code ?? pick.code) : pick.code;
    const name = isPlaceholderStockName(pick.name) ? (fallback?.candidate.name ?? pick.name) : pick.name;
    const rootTheme = pick.root_theme || relatedTheme?.theme;
    const supportingNews = dedupeHeadlineStrings((pick.supporting_news ?? []).length > 0
      ? (pick.supporting_news ?? [])
      : (relatedTheme?.news_items ?? [])
          .map((item) => item.headline)
          .filter(Boolean)
    );
    const relevanceScore = pickRelevanceScore(pick, relatedTheme, supportingNews);
    const themeCandidates = relatedTheme ? findThemeRelevantCandidates(relatedTheme, "all") : [];
    const listedCandidate = findListedCandidateForPick(code, name);
    const matchesThemeCandidates = pickMatchesThemeCandidates({ ...pick, code, name }, themeCandidates);
    const businessKeywordScore = pickBusinessKeywordScore(pick, themeCandidates);
    const mentionedInEvidence = relatedTheme
      ? pickMentionedInThemeEvidence(code, name, relatedTheme, supportingNews)
      : false;
    const listDrivenTheme = relatedTheme ? isListDrivenTheme(relatedTheme) : false;
    const isFallbackSubstituted =
      !!fallback &&
      (isPlaceholderStockCode(pick.code) || isPlaceholderStockName(pick.name)) &&
      fallback.candidate.code === code;
    const hasStrongNarrative =
      relevanceScore >= 4 &&
      businessKeywordScore >= 2 &&
      pick.confidence >= 7 &&
      supportingNews.length > 0;
    const themeNewsCount = (relatedTheme?.news_items ?? []).length;
    const evidenceSourceCount = relatedTheme ? themeSourceCount(relatedTheme) : 0;
    const xOnlyTheme = relatedTheme ? themeHasOnlyXEvidence(relatedTheme) : false;
    const hasBroadEvidence =
      supportingNews.length >= 2 ||
      themeNewsCount >= 2 ||
      evidenceSourceCount >= 2;
    const hasConcreteBenefitLink =
      mentionedInEvidence ||
      matchesThemeCandidates ||
      businessKeywordScore >= 2;
    const weakConfidence = pick.confidence < 5;

    if (!relatedTheme) continue;
    if (isPlaceholderStockCode(code) || isPlaceholderStockName(name)) continue;
    if ((isPlaceholderStockCode(pick.code) || isPlaceholderStockName(pick.name)) && !fallback) continue;
    if (weakConfidence && !hasStrongNarrative) continue;
    if (listDrivenTheme && isFallbackSubstituted) continue;
    if (isFallbackSubstituted && !mentionedInEvidence && businessKeywordScore < 2) continue;
    if (listDrivenTheme && !mentionedInEvidence && !matchesThemeCandidates) continue;
    if (!hasBroadEvidence && !hasConcreteBenefitLink) continue;
    if (themeCandidates.length === 0 && !mentionedInEvidence) continue;
    if (themeCandidates.length === 0 && (pick.confidence < 6 || !hasBroadEvidence)) continue;
    if (themeCandidates.length > 0
      && matchesThemeCandidates
      && !mentionedInEvidence
      && businessKeywordScore < 2
      && pick.confidence < 6) {
      continue;
    }
    if (xOnlyTheme && (pick.confidence < 8 || businessKeywordScore < 3 || supportingNews.length < 2)) {
      continue;
    }
    if (themeCandidates.length > 0
      && !matchesThemeCandidates
      && !isFallbackSubstituted
      && !hasStrongNarrative) {
      continue;
    }
    if (!hasConcreteBenefitLink && !hasStrongNarrative) continue;
    if (relevanceScore < 3) continue;
    if (listDrivenTheme && relevanceScore < 4) continue;
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);

    normalized.push({
      ...pick,
      code,
      name,
      confidence: fallback && (isPlaceholderStockCode(pick.code) || isPlaceholderStockName(pick.name))
        ? Math.min(pick.confidence, 6)
        : pick.confidence,
      root_theme: rootTheme || undefined,
      supporting_news: supportingNews,
      benefit_type: relatedTheme && listedCandidate
        ? candidateBenefitTypeForTheme(relatedTheme, listedCandidate)
        : (mentionedInEvidence ? "origin" : pick.benefit_type),
    });
  }

  return normalized.map((pick, index) => ({ ...pick, rank: index + 1 }));
}

/** レスポンステキストを StockAnalysisResult にパース */
function looksLikeNamedCompanyNews(headline: string): boolean {
  return /^[^-\s]{2,30}---/.test(headline) || /[（(]\d{4}[)）]/.test(headline);
}

function hasNamedCompanyNews(theme: TrendingTheme): boolean {
  return (theme.news_items ?? []).some((item) => looksLikeNamedCompanyNews(item.headline));
}

function isMarketBackdropTheme(theme: TrendingTheme): boolean {
  const haystack = combineThemeEvidence(theme);
  const hasBackdropPattern = MARKET_BACKDROP_PATTERNS.some((pattern) => pattern.test(haystack));
  if (!hasBackdropPattern) return false;
  if (hasNamedCompanyNews(theme)) return false;
  return hasStrongBackdropEvidence(theme);
}

function themeInvestabilityScore(
  theme: TrendingTheme,
  xContext?: XPromptContext
): number {
  const enrichedTheme = enrichThemeForInvestability(theme, xContext);
  const xSupport = summarizeThemeXSupport(theme, xContext);
  const candidateMatches = findThemeRelevantCandidates(enrichedTheme, "all", xContext)
    .filter((candidate) => scoreThemeCandidate(enrichedTheme, candidate, xContext) >= 2)
    .length;
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(enrichedTheme, xContext);
  const hasProcessPath = beneficiaryProcesses.length > 0;
  const haystack = combineThemeEvidence(enrichedTheme);

  let score = themePriorityScore(enrichedTheme);
  if (hasNamedCompanyNews(enrichedTheme)) score += 4;
  score += Math.min(4, candidateMatches * 2);
  if (hasProcessPath) score += 6 + Math.min(2, beneficiaryProcesses.length);
  if (themeSourceCount(enrichedTheme) >= 2) score += 1;
  if (hasNonListDrivenNews(enrichedTheme)) score += 1;
  if (xSupport) {
    score += Math.min(4, xSupport.uniqueAccounts * 2);
    score += Math.min(4, Math.round(xSupport.supportScore / 3));
  }
  if (isMarketBackdropTheme(enrichedTheme)) score -= 8;
  if (isListDrivenTheme(enrichedTheme)) score -= hasProcessPath ? 2 : 6;
  if (isWeakInvestableTheme(enrichedTheme, xContext)) score -= 12;
  if (/決算速報|イチオシ決算|高配当|信用期日|ランキング|一覧/.test(haystack) && !hasProcessPath) score -= 8;
  if (/下請法|ガバナンス|勧告|コンプライアンス/.test(haystack) && !hasProcessPath) score -= 7;
  return score;
}

function splitThemesByRole(
  themes: TrendingTheme[],
  xContext?: XPromptContext
): { marketBackdrop: TrendingTheme[]; investableThemes: TrendingTheme[] } {
  const enrichedThemes = themes.map((theme) => enrichThemeForInvestability(theme, xContext));
  const sorted = [...enrichedThemes].sort((a, b) => {
    const investabilityDiff = themeInvestabilityScore(b, xContext) - themeInvestabilityScore(a, xContext);
    if (investabilityDiff !== 0) return investabilityDiff;
    return themePriorityScore(b) - themePriorityScore(a);
  });

  const marketBackdrop: TrendingTheme[] = [];
  const investableThemes: TrendingTheme[] = [];

  for (const theme of sorted) {
    if (isMarketBackdropTheme(theme)) {
      if (!marketBackdrop.some((existing) => themesSubstantiallyOverlap(existing, theme))) {
        marketBackdrop.push(theme);
      }
      continue;
    }
    if (!isEligibleInvestableTheme(theme, xContext)) {
      continue;
    }
    if (marketBackdrop.some((backdropTheme) => themesSubstantiallyOverlap(backdropTheme, theme))) {
      continue;
    }
    if (investableThemes.some((existing) => themesSubstantiallyOverlap(existing, theme))) {
      continue;
    }
    investableThemes.push(theme);
  }

  const trimmedBackdrop = marketBackdrop.slice(0, MAX_BACKDROP_THEMES);
  const trimmedInvestable = investableThemes
    .filter((theme) => !trimmedBackdrop.some((backdropTheme) => themesSubstantiallyOverlap(backdropTheme, theme)))
    .slice(0, MAX_INVESTABLE_THEME_COUNT);

  return {
    marketBackdrop: trimmedBackdrop,
    investableThemes: trimmedInvestable,
  };
}

function classifyPickRole(
  pick: StockPick,
  themes: TrendingTheme[]
): "direct" | "associative" {
  const relatedTheme = findThemeForPick(pick, themes);
  if (!relatedTheme) return "associative";

  const supportingNews = dedupeHeadlineStrings((pick.supporting_news ?? []).length > 0
    ? (pick.supporting_news ?? [])
    : (relatedTheme.news_items ?? []).map((item) => item.headline)
  );
  const mentionedInEvidence = pickMentionedInThemeEvidence(
    pick.code,
    pick.name,
    relatedTheme,
    supportingNews
  );

  if (themeHasOnlyXEvidence(relatedTheme)) return "associative";
  if (mentionedInEvidence) return "direct";
  if (supportingNews.some((headline) => looksLikeNamedCompanyNews(headline))) return "direct";
  return "associative";
}

function isStrongAssociativePick(
  pick: StockPick,
  themes: TrendingTheme[],
  xContext?: XPromptContext
): boolean {
  const relatedTheme = findThemeForPick(pick, themes);
  if (!relatedTheme) return false;

  const supportingNews = dedupeHeadlineStrings((pick.supporting_news ?? []).length > 0
    ? (pick.supporting_news ?? [])
    : (relatedTheme.news_items ?? []).map((item) => item.headline)
  );
  const themeCandidates = findThemeRelevantCandidates(relatedTheme, "associative", xContext);
  const businessKeywordScore = pickBusinessKeywordScore(pick, themeCandidates);
  const relevanceScore = pickRelevanceScore(pick, relatedTheme, supportingNews);
  const xSupport = summarizeThemeXSupport(relatedTheme, xContext);
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(relatedTheme, xContext);
  const listedCandidate = findListedCandidateForPick(pick.code, pick.name);
  const benefitType = listedCandidate
    ? candidateBenefitTypeForTheme(relatedTheme, listedCandidate, xContext)
    : (pick.benefit_type ?? (pickMentionedInThemeEvidence(pick.code, pick.name, relatedTheme, supportingNews) ? "origin" : "peripheral"));
  const preferredPeripheral = listedCandidate
    ? isPreferredPeripheralCandidate(relatedTheme, listedCandidate, xContext)
    : false;
  const processLinkScore = beneficiaryProcesses.reduce((score, process) => {
    const key = normalizeMatchText(process);
    const haystack = normalizeMatchText([pick.chain, pick.reasoning, pick.catalyst].join(" "));
    return key && haystack.includes(key) ? score + 1 : score;
  }, 0);
  const broadEvidence =
    supportingNews.length >= 2 ||
    themeSourceCount(relatedTheme) >= 2 ||
    (xSupport?.uniqueAccounts ?? 0) >= 2;

  return benefitType === "peripheral" &&
    beneficiaryProcesses.length > 0 &&
    (businessKeywordScore >= 2 || processLinkScore >= 1) &&
    relevanceScore >= 4 &&
    (broadEvidence || pick.confidence >= 8 || preferredPeripheral);
}

function isUsefulWatchPick(
  pick: StockPick,
  themes: TrendingTheme[],
  xContext?: XPromptContext
): boolean {
  const relatedTheme = findThemeForPick(pick, themes);
  if (!relatedTheme) return false;

  const listedCandidate = findListedCandidateForPick(pick.code, pick.name);
  const benefitType = listedCandidate
    ? candidateBenefitTypeForTheme(relatedTheme, listedCandidate, xContext)
    : (pick.benefit_type ?? "peripheral");
  const beneficiaryProcesses = inferThemeBeneficiaryProcesses(relatedTheme, xContext);
  const supportingNews = dedupeHeadlineStrings((pick.supporting_news ?? []).length > 0
    ? (pick.supporting_news ?? [])
    : (relatedTheme.news_items ?? []).map((item) => item.headline)
  );
  const xSupport = summarizeThemeXSupport(relatedTheme, xContext);
  const evidenceStrong =
    supportingNews.length >= 1 ||
    themeSourceCount(relatedTheme) >= 2 ||
    (xSupport?.uniqueAccounts ?? 0) >= 2;

  if (isMarketBackdropTheme(relatedTheme) && beneficiaryProcesses.length === 0) return false;
  if (beneficiaryProcesses.length === 0 && benefitType !== "origin") return false;
  if (benefitType === "peripheral") {
    return pick.confidence >= 4 && (beneficiaryProcesses.length > 0 || evidenceStrong);
  }
  if (benefitType === "primary") {
    return pick.confidence >= 4 && beneficiaryProcesses.length > 0 && evidenceStrong;
  }
  return pick.confidence >= 4 && evidenceStrong;
}

function dedupePicksByCode(picks: StockPick[], limit: number): StockPick[] {
  const deduped = new Map<string, StockPick>();

  for (const pick of picks) {
    if (!pick.code || deduped.has(pick.code)) continue;
    deduped.set(pick.code, pick);
    if (deduped.size >= limit) break;
  }

  return Array.from(deduped.values()).map((pick, index) => ({
    ...pick,
    rank: index + 1,
  }));
}

function refineAnalysisStructure(
  result: StockAnalysisResult,
  xContext?: XPromptContext,
  debugLogs: string[] = []
): StockAnalysisResult {
  const { marketBackdrop, investableThemes } = splitThemesByRole(result.trending_themes, xContext);
  const directPicks: StockPick[] = [];
  const associativePicks: StockPick[] = [];
  const demotedWatchPicks: StockPick[] = [];

  for (const pick of result.stock_picks) {
    const role = classifyPickRole(
      pick,
      investableThemes.length > 0 ? investableThemes : result.trending_themes
    );
    if (role === "direct") {
      directPicks.push(pick);
    } else {
      if (isStrongAssociativePick(pick, investableThemes, xContext)) {
        associativePicks.push(pick);
      } else {
        const demotedPick = {
          ...pick,
          confidence: Math.min(4, pick.confidence),
        };
        if (isUsefulWatchPick(demotedPick, investableThemes.length > 0 ? investableThemes : result.trending_themes, xContext)) {
          demotedWatchPicks.push(demotedPick);
        }
      }
    }
  }

  const synthesizedAssociative = associativePicks.length === 0
    ? synthesizePicksFromThemesStrict(investableThemes)
        .filter((pick) => isStrongAssociativePick(pick, investableThemes, xContext))
    : [];
  const finalizedAssociative = dedupePicksByCode(
    [...associativePicks, ...synthesizedAssociative],
    MAX_ASSOCIATIVE_PICKS
  );
  const finalizedDirect = dedupePicksByCode(directPicks, MAX_DIRECT_PICKS);
  const watchThemes = investableThemes.length > 0
    ? [...investableThemes, ...marketBackdrop]
    : result.trending_themes;
  const synthesizedWatch = finalizedAssociative.length === 0
    ? synthesizeWatchCandidatesFromThemes(watchThemes, xContext, debugLogs)
        .slice(0, MAX_WATCH_CANDIDATES)
    : [];
  const watchCandidates = finalizedAssociative.length === 0
    ? dedupePicksByCode(
        [...demotedWatchPicks, ...synthesizedWatch],
        MAX_WATCH_CANDIDATES
      )
    : [];
  const nextCheckGuidance = buildNextCheckGuidanceFromThemes(marketBackdrop, investableThemes, xContext);
  const nextChecks = buildNextChecksFromGuidance(nextCheckGuidance);
  const noIdeaDay = finalizedDirect.length === 0 && finalizedAssociative.length === 0 && watchCandidates.length === 0;
  const sectorWatch = noIdeaDay ? buildSectorWatchFromGuidance(nextCheckGuidance) : [];
  const processWatch = noIdeaDay ? buildProcessWatchFromGuidance(nextCheckGuidance) : [];

  return {
    ...result,
    trending_themes: [...investableThemes, ...marketBackdrop].slice(0, MAX_THEME_COUNT),
    stock_picks: finalizedAssociative,
    watch_candidates: watchCandidates,
    market_backdrop: marketBackdrop,
    investable_themes: investableThemes,
    direct_picks: finalizedDirect,
    associative_picks: finalizedAssociative,
    sector_watch: sectorWatch,
    process_watch: processWatch,
    next_checks: nextChecks,
    next_check_guidance: nextCheckGuidance,
    source_list: dedupeSourceReferences(result.source_list ?? []),
  };
}

function parseAnalysisResponse(text: string): StockAnalysisResult {
  const json = extractJson(text);
  const data = JSON.parse(json) as Partial<StockAnalysisResult>;

  // 必須フィールドの検証
  if (!data.stock_picks || !Array.isArray(data.stock_picks)) {
    throw new Error("stock_picks フィールドが不正です");
  }
  if (!data.trending_themes || !Array.isArray(data.trending_themes)) {
    throw new Error("trending_themes フィールドが不正です");
  }

  // stock_picks の 4 桁コード正規化
  const picks = data.stock_picks.map((p, i): StockPick => ({
    rank:       p.rank       ?? i + 1,
    code:       String(p.code ?? "").replace(/\D/g, "").slice(0, 4).padStart(4, "0"),
    name:       p.name       ?? "",
    chain:      p.chain      ?? "",
    reasoning:  p.reasoning  ?? "",
    confidence: Math.min(10, Math.max(1, Number(p.confidence ?? 5))),
    risk:       p.risk       ?? "",
    catalyst:   p.catalyst   ?? "",
  }));

  return {
    analysis_date:    data.analysis_date    ?? new Date().toLocaleString("ja-JP"),
    trending_themes:  data.trending_themes,
    stock_picks:      picks,
    watch_candidates: [],
    market_sentiment: data.market_sentiment ?? "",
  };
}

function parseStructuredAnalysisResponse(text: string): StockAnalysisResult {
  const json = extractJson(text);
  const data = JSON.parse(json) as Record<string, unknown>;
  const rawThemes = Array.isArray(data.trending_themes) ? data.trending_themes : null;
  const rawPicks = Array.isArray(data.stock_picks) ? data.stock_picks : null;

  if (!rawThemes) throw new Error("trending_themes フィールドが不正です");
  if (!rawPicks) throw new Error("stock_picks フィールドが不正です");

  const trendingThemes = rawThemes.map((theme, index): TrendingTheme => {
    const record = theme as Record<string, unknown>;
    return {
      theme: asString(record.theme) || `テーマ${index + 1}`,
      mention_count: Math.max(0, Number(record.mention_count ?? 0)),
      key_tweets: asStringArray(record.key_tweets, 3),
      why_it_matters: asString(record.why_it_matters) || undefined,
      news_items: parseThemeNewsItems(record.news_items),
    };
  });

  const stockPicks = rawPicks.map((pick, index): StockPick => {
    const record = pick as Record<string, unknown>;
    return {
      rank: Number(record.rank ?? index + 1),
      code: String(record.code ?? "").replace(/\D/g, "").slice(0, 4).padStart(4, "0"),
      name: asString(record.name),
      chain: asString(record.chain),
      reasoning: asString(record.reasoning),
      confidence: Math.min(10, Math.max(1, Number(record.confidence ?? 5))),
      risk: asString(record.risk),
      catalyst: asString(record.catalyst),
      root_theme: asString(record.root_theme) || undefined,
      supporting_news: asStringArray(record.supporting_news, 3),
    };
  });

  return {
    analysis_date: asString(data.analysis_date) || new Date().toLocaleString("ja-JP"),
    trending_themes: trendingThemes,
    stock_picks: stockPicks,
    watch_candidates: [],
    market_sentiment: asString(data.market_sentiment),
    source_list: parseSourceList(data.source_list),
  };
}

// ─── OpenAI API 呼び出し ───────────────────────────────────────
function parseCompactStructuredAnalysisResponse(text: string): StockAnalysisResult {
  const data = parseJsonRecord(text);
  const rawThemes = pickArray(data, "trending_themes", "themes");
  const rawPicks = pickArray(data, "stock_picks", "picks");

  if (rawThemes.length === 0 && rawPicks.length === 0) {
    throw new Error("structured analysis result is missing both themes and picks");
  }

  const trendingThemes = rawThemes
    .filter((theme): theme is Record<string, unknown> => !!theme && typeof theme === "object")
    .slice(0, MAX_THEME_COUNT)
    .map((record, index): TrendingTheme => ({
      theme: pickString(record, "theme", "t") || `テーマ${index + 1}`,
      mention_count: Math.max(0, pickNumber(record, "mention_count", "mc", "count")),
      key_tweets: asStringArray(record.key_tweets ?? record.kt, MAX_THEME_KEY_TWEETS)
        .map((item) => truncate(item, MAX_THEME_SUMMARY_LEN)),
      why_it_matters:
        truncate(pickString(record, "why_it_matters", "why"), MAX_THEME_SUMMARY_LEN) || undefined,
      news_items: parseThemeNewsItems(record.news_items ?? record.news),
    }));
  const normalizedThemes = normalizeAndMergeThemes(trendingThemes);

  const stockPicks = rawPicks
    .filter((pick): pick is Record<string, unknown> => !!pick && typeof pick === "object")
    .slice(0, MAX_STOCK_PICKS)
    .map((record, index): StockPick => ({
      rank: Math.max(1, pickNumber(record, "rank", "r") || index + 1),
      code: String(record.code ?? record.c ?? "").replace(/\D/g, "").slice(0, 4).padStart(4, "0"),
      name: truncate(pickString(record, "name", "n"), 40),
      chain: truncate(pickString(record, "chain", "ch"), MAX_PICK_TEXT_LEN),
      reasoning: truncate(pickString(record, "reasoning", "re"), MAX_PICK_TEXT_LEN),
      confidence: Math.min(10, Math.max(1, pickNumber(record, "confidence", "cf") || 5)),
      risk: truncate(pickString(record, "risk"), MAX_PICK_TEXT_LEN),
      catalyst: truncate(pickString(record, "catalyst", "cat"), MAX_PICK_TEXT_LEN),
      root_theme: truncate(pickString(record, "root_theme", "rt"), 40) || undefined,
      supporting_news: asStringArray(record.supporting_news ?? record.sn, MAX_PICK_SUPPORTING_NEWS)
        .map((item) => truncate(item, MAX_THEME_SUMMARY_LEN)),
    }));

  const sourceList = parseSourceList(data.source_list ?? data.sources);
  const normalizedPicks = normalizeStockPicks(stockPicks, normalizedThemes, sourceList);
  const finalPicks = normalizedPicks.length > 0
    ? normalizedPicks
    : synthesizePicksFromThemesStrict(normalizedThemes);
  const watchCandidates = finalPicks.length === 0
    ? synthesizeWatchCandidatesFromThemes(normalizedThemes)
    : [];

  return {
    analysis_date: pickString(data, "analysis_date", "d") || new Date().toLocaleString("ja-JP"),
    trending_themes: normalizedThemes,
    stock_picks: finalPicks,
    watch_candidates: watchCandidates,
    market_sentiment: truncate(pickString(data, "market_sentiment", "sent"), MAX_PICK_TEXT_LEN),
    source_list: sourceList,
  };
}

function formatFullAnalysisMarkdown(result: StockAnalysisResult): string {
  const lines: string[] = [
    `# 株クラAI分析レポート`,
    ``,
    `- 分析日時: ${result.analysis_date}`,
    `- テーマ数: ${result.trending_themes.length}`,
    `- 銘柄候補数: ${result.stock_picks.length}`,
    ``,
    `## 今日の主要テーマ`,
  ];

  for (const theme of result.trending_themes) {
    lines.push(``);
    lines.push(`### ${theme.theme} (${theme.mention_count}件)`);
    if (theme.why_it_matters) lines.push(`- なぜ重要か: ${theme.why_it_matters}`);
    for (const news of theme.news_items ?? []) {
      lines.push(`- 根拠ニュース: ${news.headline}`);
      if (news.summary) lines.push(`  - 要点: ${news.summary}`);
      lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
      if (news.url) lines.push(`  - URL: ${news.url}`);
    }
    for (const point of theme.key_tweets) {
      lines.push(`- 補足観測: ${point}`);
    }
  }

  lines.push(``, `## 注目銘柄`);
  for (const pick of result.stock_picks) {
    lines.push(``);
    lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
    if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
    if ((pick.supporting_news ?? []).length > 0) {
      lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
    }
    lines.push(`- 連想経路: ${pick.chain}`);
    lines.push(`- 理由: ${pick.reasoning}`);
    lines.push(`- カタリスト: ${pick.catalyst}`);
    lines.push(`- リスク: ${pick.risk}`);
    lines.push(`- 確信度: ${pick.confidence}/10`);
  }

  lines.push(``, `## 市場センチメント`, result.market_sentiment || `情報不足`);

  if ((result.source_list ?? []).length > 0) {
    lines.push(``, `## ソース一覧`);
    for (const source of result.source_list ?? []) {
      lines.push(`- [${source.source}] ${source.headline}`);
      if (source.timestamp) lines.push(`  - 時刻: ${source.timestamp}`);
      if (source.url) lines.push(`  - URL: ${source.url}`);
    }
  }

  return lines.join("\n");
}

function formatEnhancedFullAnalysisMarkdown(result: StockAnalysisResult): string {
  const lines: string[] = [
    "# 株クラAI分析レポート",
    "",
    `- 分析日時: ${result.analysis_date}`,
    `- テーマ数: ${result.trending_themes.length}`,
    `- 本命候補数: ${result.stock_picks.length}`,
    `- 監視候補数: ${(result.watch_candidates ?? []).length}`,
    "",
    "## 今日の主要テーマ",
  ];

  for (const theme of result.trending_themes) {
    lines.push("");
    lines.push(`### ${theme.theme} (${theme.mention_count}件)`);
    if (theme.why_it_matters) lines.push(`- なぜ重要か: ${theme.why_it_matters}`);
    for (const news of theme.news_items ?? []) {
      lines.push(`- 根拠ニュース: ${news.headline}`);
      if (news.summary) lines.push(`  - 要点: ${news.summary}`);
      lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
      if (news.url) lines.push(`  - URL: ${news.url}`);
    }
    for (const point of theme.key_tweets) {
      lines.push(`- 補足: ${point}`);
    }
  }

  lines.push("", "## 注目銘柄");
  if (result.stock_picks.length === 0) {
    lines.push("- 本命候補は見送り。弱い根拠での補完はしていません。");
  } else {
    for (const pick of result.stock_picks) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 連想経路: ${pick.chain}`);
      lines.push(`- 理由: ${pick.reasoning}`);
      lines.push(`- カタリスト: ${pick.catalyst}`);
      lines.push(`- リスク: ${pick.risk}`);
      lines.push(`- 確度: ${pick.confidence}/10`);
    }
  }

  if ((result.watch_candidates ?? []).length > 0) {
    lines.push("", "## 監視候補");
    for (const pick of result.watch_candidates ?? []) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      if (pick.root_theme) lines.push(`- 注視テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 起点ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 監視理由: ${pick.reasoning}`);
      lines.push(`- 次に確認: ${pick.catalyst}`);
      lines.push(`- 留意点: ${pick.risk}`);
      lines.push(`- 監視確度: ${pick.confidence}/10`);
    }
  }

  lines.push("", "## 市場センチメント", result.market_sentiment || "情報不足");

  if ((result.source_list ?? []).length > 0) {
    lines.push("", "## ソース一覧");
    for (const source of result.source_list ?? []) {
      lines.push(`- [${source.source}] ${source.headline}`);
      if (source.timestamp) lines.push(`  - 時刻: ${source.timestamp}`);
      if (source.url) lines.push(`  - URL: ${source.url}`);
    }
  }

  return lines.join("\n");
}

function formatEnhancedFullAnalysisMarkdownV2(result: StockAnalysisResult): string {
  const backdropThemes = result.market_backdrop ?? [];
  const investableThemes = result.investable_themes ?? result.trending_themes;
  const directPicks = result.direct_picks ?? [];
  const associativePicks = result.associative_picks ?? result.stock_picks;
  const watchCandidates = result.watch_candidates ?? [];
  const lines: string[] = [
    "# 株クラAI分析レポート",
    "",
    `- 分析日時: ${result.analysis_date}`,
    `- market_backdrop: ${backdropThemes.length}`,
    `- investable_themes: ${investableThemes.length}`,
    `- direct_picks: ${directPicks.length}`,
    `- associative_picks: ${associativePicks.length}`,
    `- watch_candidates: ${watchCandidates.length}`,
  ];

  if (backdropThemes.length > 0) {
    lines.push("", "## Market Backdrop");
    for (const theme of backdropThemes) {
      lines.push("");
      lines.push(`### ${theme.theme}`);
      if (theme.why_it_matters) lines.push(`- 背景: ${theme.why_it_matters}`);
      for (const news of (theme.news_items ?? []).slice(0, 1)) {
        lines.push(`- 根拠: ${news.headline}`);
        if (news.summary) lines.push(`  - 要点: ${news.summary}`);
        lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
      }
    }
  }

  lines.push("", "## Investable Themes");
  for (const theme of investableThemes) {
    lines.push("");
    lines.push(`### ${theme.theme} (${theme.mention_count}件)`);
    if (theme.why_it_matters) lines.push(`- なぜ効くか: ${theme.why_it_matters}`);
    if ((theme.beneficiary_processes ?? []).length > 0) {
      lines.push(`- 受益工程: ${(theme.beneficiary_processes ?? []).join(" -> ")}`);
    }
    for (const news of theme.news_items ?? []) {
      lines.push(`- 根拠ニュース: ${news.headline}`);
      if (news.summary) lines.push(`  - 要点: ${news.summary}`);
      lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
      if (news.url) lines.push(`  - URL: ${news.url}`);
    }
    for (const point of theme.key_tweets) {
      lines.push(`- 補助シグナル: ${point}`);
    }
  }

  lines.push("", "## Direct Picks");
  if (directPicks.length === 0) {
    lines.push("- 直接材料株は今回は採用なし");
  } else {
    for (const pick of directPicks) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push(`- 区分: 直接材料`);
      if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 直接材料: ${pick.reasoning}`);
      lines.push(`- 注目点: ${pick.catalyst}`);
      lines.push(`- リスク: ${pick.risk}`);
      lines.push(`- 確度: ${pick.confidence}/10`);
    }
  }

  lines.push("", "## Associative Picks");
  if (associativePicks.length === 0) {
    lines.push("- 本命候補は見送り。弱い根拠での補完はしていません。");
  } else {
    for (const pick of associativePicks) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push(`- 区分: ${pick.benefit_type === "peripheral" ? "桶屋本命" : "本命候補"}`);
      if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 連想経路: ${pick.chain}`);
      lines.push(`- 受益理由: ${pick.reasoning}`);
      lines.push(`- カタリスト: ${pick.catalyst}`);
      lines.push(`- リスク: ${pick.risk}`);
      lines.push(`- 確度: ${pick.confidence}/10`);
    }
  }

  if (watchCandidates.length > 0) {
    lines.push("", "## Watch Candidates");
    for (const pick of watchCandidates) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push(`- 区分: ${describeBenefitType(pick.benefit_type) ?? "監視候補"}`);
      if (pick.root_theme) lines.push(`- 注視テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 起点ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 受益工程: ${pick.chain}`);
      lines.push(`- 監視理由: ${pick.reasoning}`);
      lines.push(`- 本命化条件: ${pick.catalyst}`);
      lines.push(`- 否定条件/弱さ: ${pick.risk}`);
      lines.push(`- 監視確度: ${pick.confidence}/10`);
    }
  }

  lines.push("", "## Market Sentiment", result.market_sentiment || "情報不足");

  if ((result.source_list ?? []).length > 0) {
    lines.push("", "## Source List");
    for (const source of result.source_list ?? []) {
      lines.push(`- [${source.source}] ${source.headline}`);
      if (source.timestamp) lines.push(`  - 時刻: ${source.timestamp}`);
      if (source.url) lines.push(`  - URL: ${source.url}`);
    }
  }

  return lines.join("\n");
}

function formatEnhancedFullAnalysisMarkdownV3(result: StockAnalysisResult): string {
  const backdropThemes = result.market_backdrop ?? [];
  const investableThemes = result.investable_themes ?? result.trending_themes;
  const directPicks = result.direct_picks ?? [];
  const associativePicks = result.associative_picks ?? result.stock_picks;
  const watchCandidates = result.watch_candidates ?? [];
  const sectorWatch = result.sector_watch ?? [];
  const processWatch = result.process_watch ?? [];
  const nextChecks = result.next_checks ?? [];
  const nextGuidance = result.next_check_guidance ?? [];
  const guidanceMap = new Map(nextGuidance.map((item) => [normalizeHeadlineKey(item.theme), item]));
  const noIdeaDay = directPicks.length === 0 && associativePicks.length === 0 && watchCandidates.length === 0;
  const lines: string[] = [
    "# 株クラAI分析レポート",
    "",
    `- 分析日時: ${result.analysis_date}`,
    `- market_backdrop: ${backdropThemes.length}`,
    `- investable_themes: ${investableThemes.length}`,
    `- direct_picks: ${directPicks.length}`,
    `- associative_picks: ${associativePicks.length}`,
    `- watch_candidates: ${watchCandidates.length}`,
  ];

  if (backdropThemes.length > 0) {
    lines.push("", "## Market Backdrop");
    for (const theme of backdropThemes.slice(0, investableThemes.length > 0 ? 1 : 2)) {
      const guidance = guidanceMap.get(normalizeHeadlineKey(theme.theme));
      lines.push("");
      lines.push(`### ${theme.theme}`);
      if (theme.why_it_matters) lines.push(`- 背景: ${truncate(theme.why_it_matters, 84)}`);
      if (guidance?.sectors?.length) lines.push(`- 注視業種: ${guidance.sectors.join(" / ")}`);
      if (guidance?.processes?.length) lines.push(`- 注視工程: ${guidance.processes.join(" / ")}`);
      for (const news of (theme.news_items ?? []).slice(0, 1)) {
        lines.push(`- 根拠: ${news.headline}`);
        if (news.summary) lines.push(`  - 要点: ${news.summary}`);
        lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
        if (news.url) lines.push(`  - URL: ${news.url}`);
      }
    }
  }

  lines.push("", "## Investable Themes");
  if (investableThemes.length === 0) {
    lines.push("- 今日は背景相場中心で、投資テーマは見送り。");
  } else {
    for (const theme of investableThemes) {
      lines.push("");
      lines.push(`### ${theme.theme} (${theme.mention_count}件)`);
      if (theme.why_it_matters) lines.push(`- なぜ効くか: ${theme.why_it_matters}`);
      if ((theme.beneficiary_processes ?? []).length > 0) {
        lines.push(`- 受益工程: ${(theme.beneficiary_processes ?? []).join(" -> ")}`);
      }
      for (const news of theme.news_items ?? []) {
        lines.push(`- 根拠ニュース: ${news.headline}`);
        if (news.summary) lines.push(`  - 要点: ${news.summary}`);
        lines.push(`  - ソース: ${news.source}${news.timestamp ? ` / ${news.timestamp}` : ""}`);
        if (news.url) lines.push(`  - URL: ${news.url}`);
      }
      for (const point of theme.key_tweets) {
        lines.push(`- 補助シグナル: ${point}`);
      }
    }
  }

  lines.push("", "## Direct Picks");
  if (directPicks.length === 0) {
    lines.push("- 直接材料株は今回は採用なし");
  } else {
    for (const pick of directPicks) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push("- 区分: 直接材料");
      if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 直接材料: ${pick.reasoning}`);
      lines.push(`- 注目点: ${pick.catalyst}`);
      lines.push(`- リスク: ${pick.risk}`);
      lines.push(`- 確度: ${pick.confidence}/10`);
    }
  }

  lines.push("", "## Associative Picks");
  if (associativePicks.length === 0) {
    lines.push("- 本命候補は見送り。弱い根拠での補完はしていません。");
  } else {
    for (const pick of associativePicks) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push(`- 区分: ${pick.benefit_type === "peripheral" ? "周辺工程本命" : "本命候補"}`);
      if (pick.root_theme) lines.push(`- 根拠テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 連想経路: ${pick.chain}`);
      lines.push(`- 工程理由: ${pick.reasoning}`);
      lines.push(`- カタリスト: ${pick.catalyst}`);
      lines.push(`- リスク: ${pick.risk}`);
      lines.push(`- 確度: ${pick.confidence}/10`);
    }
  }

  lines.push("", "## Watch Candidates");
  if (watchCandidates.length === 0) {
    lines.push("- 監視候補なし。条件がそろうまで見送り。");
  } else {
    for (const pick of watchCandidates) {
      lines.push("");
      lines.push(`### ${pick.rank}. ${pick.name} (${pick.code})`);
      lines.push(`- 区分: ${describeBenefitType(pick.benefit_type) ?? "監視候補"}`);
      if (pick.root_theme) lines.push(`- 注視テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        lines.push(`- 起点ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      lines.push(`- 受益工程: ${pick.chain}`);
      lines.push(`- 監視理由: ${pick.reasoning}`);
      lines.push(`- 本命化条件: ${pick.catalyst}`);
      lines.push(`- 否定条件/弱さ: ${pick.risk}`);
      lines.push(`- 監視確度: ${pick.confidence}/10`);
    }
  }

  if (noIdeaDay && nextChecks.length > 0) {
    if (sectorWatch.length > 0) {
      lines.push("", "## Sector Watch");
      for (const item of sectorWatch.slice(0, 3)) {
        lines.push(`- ${item.sector}`);
        lines.push(`  - 注視テーマ: ${item.theme}`);
        lines.push(`  - 理由: ${item.why}`);
        if (item.promotion_conditions.length > 0) {
          lines.push(`  - 昇格条件: ${item.promotion_conditions.join(" / ")}`);
        }
      }
    }

    if (processWatch.length > 0) {
      lines.push("", "## Process Watch");
      for (const item of processWatch.slice(0, 3)) {
        lines.push(`- ${item.process}`);
        lines.push(`  - 注視テーマ: ${item.theme}`);
        lines.push(`  - 何を見るか: ${item.focus}`);
        if (item.promotion_conditions.length > 0) {
          lines.push(`  - 昇格条件: ${item.promotion_conditions.join(" / ")}`);
        }
      }
    }

    lines.push("", "## Next Checks");
    if (nextGuidance.length > 0) {
      for (const item of nextGuidance) {
        lines.push(`- ${item.theme}`);
        if (item.sectors.length > 0) lines.push(`  - 注視業種: ${item.sectors.join(" / ")}`);
        if (item.processes.length > 0) lines.push(`  - 注視工程: ${item.processes.join(" / ")}`);
        if (item.triggers.length > 0) lines.push(`  - 昇格条件: ${item.triggers.join(" / ")}`);
      }
    } else {
      for (const item of nextChecks) {
        lines.push(`- ${item}`);
      }
    }
  }

  lines.push("", "## Market Sentiment", result.market_sentiment || "市場観測なし");

  if ((result.source_list ?? []).length > 0) {
    lines.push("", "## Source List");
    for (const source of result.source_list ?? []) {
      const roleLabel =
        source.role === "investable" ? "investable"
        : source.role === "sector_watch" ? "sector_watch"
        : source.role === "process_watch" ? "process_watch"
        : source.role === "backdrop" ? "backdrop"
        : source.source;
      lines.push(`- [${roleLabel}/${source.source}] ${source.headline}`);
      if (source.timestamp) lines.push(`  - 投稿日時: ${source.timestamp}`);
      if (source.url) lines.push(`  - URL: ${source.url}`);
    }
  }

  return lines.join("\n");
}

function formatAnalysisForLogV2(result: StockAnalysisResult): string {
  const backdropThemes = result.market_backdrop ?? [];
  const investableThemes = result.investable_themes ?? result.trending_themes;
  const directPicks = result.direct_picks ?? [];
  const associativePicks = result.associative_picks ?? result.stock_picks;
  const watchCandidates = result.watch_candidates ?? [];
  const lines: string[] = [
    "=".repeat(60),
    `株クラAI分析レポート ${result.analysis_date}`,
    "=".repeat(60),
  ];

  if (backdropThemes.length > 0) {
    lines.push("", "【Market Backdrop】");
    for (const theme of backdropThemes) {
      lines.push(`- ${theme.theme}`);
      if (theme.why_it_matters) lines.push(`  背景: ${theme.why_it_matters}`);
    }
  }

  lines.push("", "【Investable Themes】");
  for (const theme of investableThemes.slice(0, 4)) {
    lines.push(`- ${theme.theme} (${theme.mention_count}件)`);
    if (theme.why_it_matters) lines.push(`  なぜ効くか: ${theme.why_it_matters}`);
    if ((theme.beneficiary_processes ?? []).length > 0) {
      lines.push(`  受益工程: ${(theme.beneficiary_processes ?? []).join(" -> ")}`);
    }
    for (const news of (theme.news_items ?? []).slice(0, 2)) {
      const meta = [news.source, news.timestamp ? formatPromptTimestamp(news.timestamp) : ""]
        .filter(Boolean)
        .join(" / ");
      lines.push(`  根拠: ${news.headline}${meta ? ` [${meta}]` : ""}`);
    }
  }

  lines.push("", "【Associative Picks】");
  if (associativePicks.length === 0) {
    lines.push("- 本命候補なし");
  } else {
    for (const pick of associativePicks) {
      lines.push(`- ${pick.rank}. ${pick.name}(${pick.code}) conf=${pick.confidence}/10`);
      if (pick.benefit_type) lines.push(`  区分: ${describeBenefitType(pick.benefit_type)}`);
      if (pick.root_theme) lines.push(`  根拠テーマ: ${pick.root_theme}`);
      lines.push(`  連想経路: ${pick.chain}`);
      lines.push(`  受益理由: ${pick.reasoning}`);
    }
  }

  if (directPicks.length > 0) {
    lines.push("", "【Direct Picks】");
    for (const pick of directPicks) {
      lines.push(`- ${pick.rank}. ${pick.name}(${pick.code}) conf=${pick.confidence}/10`);
      if (pick.root_theme) lines.push(`  根拠テーマ: ${pick.root_theme}`);
      lines.push(`  直接材料: ${pick.reasoning}`);
    }
  }

  if (watchCandidates.length > 0) {
    lines.push("", "【Watch Candidates】");
    for (const pick of watchCandidates) {
      lines.push(`- ${pick.rank}. ${pick.name}(${pick.code}) watch=${pick.confidence}/10`);
      if (pick.benefit_type) lines.push(`  区分: ${describeBenefitType(pick.benefit_type)}`);
      if (pick.root_theme) lines.push(`  注視テーマ: ${pick.root_theme}`);
      lines.push(`  次に確認: ${pick.catalyst}`);
      lines.push(`  弱い理由: ${pick.risk}`);
    }
  }

  lines.push("", "【Market Sentiment】", result.market_sentiment || "情報不足");
  lines.push("=".repeat(60));
  return lines.join("\n");
}

async function saveFullAnalysisArtifacts(result: StockAnalysisResult): Promise<void> {
  const markdown = formatEnhancedFullAnalysisMarkdownV3(result);
  await fs.mkdir(ANALYSIS_OUTPUT_DIR, { recursive: true });
  await fs.mkdir(PAGES_OUTPUT_DIR, { recursive: true });
  await fs.writeFile(FULL_ANALYSIS_JSON_PATH, JSON.stringify(result, null, 2), "utf-8");
  await fs.writeFile(FULL_ANALYSIS_MD_PATH, markdown, "utf-8");
  await fs.writeFile(PAGES_ANALYSIS_JSON_PATH, JSON.stringify(result, null, 2), "utf-8");
  await fs.writeFile(PAGES_ANALYSIS_MD_PATH, markdown, "utf-8");
  console.log(
    `[analyzer] full report saved: ${FULL_ANALYSIS_JSON_PATH}, ${FULL_ANALYSIS_MD_PATH}, ${PAGES_ANALYSIS_JSON_PATH}, ${PAGES_ANALYSIS_MD_PATH}`
  );
}

function getOpenAIKey(): string {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENAI_API_KEY が未設定です");
  return apiKey;
}

/**
 * OpenAI API を呼び出し、失敗時はリトライプロンプトで再試行する
 * @param userPrompt 投稿データを含むユーザープロンプト
 * @param attempt    現在の試行回数（1始まり）
 */
async function callOpenAI(userPrompt: string, attempt: number): Promise<StockAnalysisResult> {
  // 2回目以降は JSON 厳守を念押し
  const retryNote = attempt > 1
    ? `\n\n⚠️ 前回の回答でJSONパースに失敗しました（試行 ${attempt}/${MAX_RETRIES}）。` +
      "コードブロックや説明文を含めず、純粋なJSONオブジェクトのみで回答してください。"
    : "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOpenAIKey()}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: "system", content: REPORT_SYSTEM_PROMPT },
          { role: "user", content: userPrompt + retryNote },
        ],
        reasoning_effort: REASONING_EFFORT,
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();

    let payload: OpenAIChatCompletionResponse;
    try {
      payload = JSON.parse(responseText) as OpenAIChatCompletionResponse;
    } catch {
      throw new Error(
        `[openai] レスポンス JSON のパースに失敗しました: ${responseText.slice(0, 300)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `[openai] HTTP ${response.status}: ` +
        `${payload.error?.message ?? response.statusText}`
      );
    }

    const rawText = payload.choices?.[0]?.message?.content;
    if (typeof rawText !== "string" || rawText.trim() === "") {
      throw new Error("[openai] 応答テキストが空です");
    }

    console.log(
      `[analyzer] OpenAI 応答受信: ${rawText.length} 文字` +
      ` (finish_reason: ${payload.choices?.[0]?.finish_reason ?? "unknown"})`
    );

    return parseStructuredAnalysisResponse(rawText);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[openai] ${REQUEST_TIMEOUT_MS}ms でタイムアウトしました`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── メイン分析関数 ────────────────────────────────────────────
/**
 * 収集した投稿を OpenAI で分析し構造化結果を返す
 */
async function callCompactOpenAI(userPrompt: string, attempt: number): Promise<StockAnalysisResult> {
  const retryNote = attempt > 1
    ? `\n\nPrevious attempt ${attempt - 1} returned incomplete output. Reduce item counts further, but return one complete valid JSON object.`
    : "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOpenAIKey()}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: "system", content: COMPACT_REPORT_SYSTEM_PROMPT },
          { role: "user", content: userPrompt + retryNote },
        ],
        reasoning_effort: REASONING_EFFORT,
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();

    let payload: OpenAIChatCompletionResponse;
    try {
      payload = JSON.parse(responseText) as OpenAIChatCompletionResponse;
    } catch {
      throw new Error(`[openai] failed to parse response JSON: ${responseText.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(
        `[openai] HTTP ${response.status}: ${payload.error?.message ?? response.statusText}`
      );
    }

    const rawText = payload.choices?.[0]?.message?.content;
    if (typeof rawText !== "string" || rawText.trim() === "") {
      throw new Error("[openai] empty completion content");
    }

    const finishReason = payload.choices?.[0]?.finish_reason ?? "unknown";
    console.log(`[analyzer] OpenAI response: ${rawText.length} chars (finish_reason: ${finishReason})`);

    try {
      return parseCompactStructuredAnalysisResponse(rawText);
    } catch (err) {
      if (finishReason === "length") {
        throw new Error(
          `[openai] finish_reason=length caused incomplete JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[openai] timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeTweets(tweets: Tweet[]): Promise<StockAnalysisResult> {
  if (tweets.length === 0) {
    console.warn("[analyzer] 投稿が 0 件のため分析をスキップ");
    return {
      analysis_date:    new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      trending_themes:  [],
      stock_picks:      [],
      watch_candidates: [],
      market_backdrop:  [],
      investable_themes: [],
      direct_picks:     [],
      associative_picks: [],
      market_sentiment: "分析対象の投稿がありませんでした",
    };
  }

  const analysisDate = new Date().toLocaleString("ja-JP", {
    timeZone:  "Asia/Tokyo",
    year:      "numeric",
    month:     "2-digit",
    day:       "2-digit",
    hour:      "2-digit",
    minute:    "2-digit",
  });

  const analysisTweets = dedupeAnalysisTweets(tweets);
  const grouped    = groupBySource(analysisTweets);
  const totalTweets = Object.values(grouped).reduce((s, a) => s + a.length, 0);
  const dedupedCount = tweets.length - analysisTweets.length;
  const xContext = buildXPromptContext(grouped.x ?? []);

  console.log(
    `[analyzer] 分析開始: ${totalTweets} 件 / ` +
    `${Object.keys(grouped).length} ソース / モデル: ${MODEL_ID}` +
    (dedupedCount > 0 ? ` / deduped=${dedupedCount}` : "")
  );
  if (ANALYZER_DEBUG_X) {
    const high = xContext.selectedTweets.filter((tweet) => xPromptSignalLevel(tweet) === "high").length;
    const mid = xContext.selectedTweets.filter((tweet) => xPromptSignalLevel(tweet) === "mid").length;
    const low = xContext.selectedTweets.filter((tweet) => xPromptSignalLevel(tweet) === "low").length;
    const topClusters = xContext.clusters
      .slice(0, 3)
      .map((cluster) => `${cluster.label}(${cluster.accounts.length}a/${cluster.posts.length}p)`)
      .join(", ");
    const accountSummary = xContext.accountWeights
      .slice(0, 5)
      .map((summary) => (
        `@${summary.username}:w=${summary.weight.toFixed(2)} rel=${summary.marketRelevantPosts}/${summary.totalPosts} early=${summary.earlyClusterMentions}`
      ))
      .join(" | ");
    console.log(
      `[analyzer][x] raw=${(grouped.x ?? []).length} selected=${xContext.selectedTweets.length} ` +
      `clusters=${xContext.clusters.length} ` +
      `high=${high} mid=${mid} low=${low}`
    );
    if (topClusters) console.log(`[analyzer][x] top_clusters=${topClusters}`);
    if (accountSummary) console.log(`[analyzer][x] accounts=${accountSummary}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const userPrompt = buildCompactUserPrompt(grouped, analysisDate, attempt, xContext);
      const rawResult = await callCompactOpenAI(userPrompt, attempt);
      const watchDebugLogs: string[] = [];
      const refinedResult = refineAnalysisStructure(rawResult, xContext, watchDebugLogs);
      const result = hydrateAnalysisSources(refinedResult, analysisTweets);
      if (ANALYZER_DEBUG_X && watchDebugLogs.length > 0) {
        for (const line of watchDebugLogs.slice(0, 8)) {
          console.log(`[analyzer][x][watch] ${line}`);
        }
      }
      await saveFullAnalysisArtifacts(result);
      console.log(
        `[analyzer] 分析完了: ` +
        `テーマ ${result.trending_themes.length} 件 / ` +
        `銘柄候補 ${result.stock_picks.length} 件`
      );
      console.log(
        `[analyzer] refined: ` +
        `investable=${(result.investable_themes ?? result.trending_themes).length} / ` +
        `direct=${(result.direct_picks ?? []).length} / ` +
        `associative=${result.stock_picks.length} / ` +
        `watch=${(result.watch_candidates ?? []).length}`
      );
      return result;
    } catch (err) {
      lastError = err;
      const isParseError = err instanceof SyntaxError ||
        (err instanceof Error && err.message.includes("フィールドが不正"));

      console.warn(
        `[analyzer] 試行 ${attempt}/${MAX_RETRIES} 失敗: ` +
        `${err instanceof Error ? err.message : String(err)}` +
        (isParseError ? "（JSONパースエラー → リトライ）" : "")
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt); // 指数的バックオフ
      }
    }
  }

  throw new Error(
    `[analyzer] ${MAX_RETRIES} 回試行しましたが分析に失敗しました: ` +
    `${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

// ─── ログ整形ヘルパー ──────────────────────────────────────────
/**
 * 分析結果をコンソール出力用に整形する
 */
export function formatAnalysisForLog(result: StockAnalysisResult): string {
  return formatAnalysisForLogV2(result);
  const enhancedLines: string[] = [
    "=".repeat(60),
    `株クラスタ分析レポート ${result.analysis_date}`,
    "=".repeat(60),
    "",
    "【今日の主要テーマ】",
  ];

  for (const theme of result.trending_themes.slice(0, 4)) {
    enhancedLines.push(`- ${theme.theme} (${theme.mention_count}件)`);
    if (theme.why_it_matters) enhancedLines.push(`  なぜ重要か: ${theme.why_it_matters}`);
    for (const news of (theme.news_items ?? []).slice(0, 2)) {
      const meta = [news.source, news.timestamp ? formatPromptTimestamp(news.timestamp) : ""]
        .filter(Boolean)
        .join(" / ");
      enhancedLines.push(`  根拠: ${news.headline}${meta ? ` [${meta}]` : ""}`);
      if (news.summary) enhancedLines.push(`    ${news.summary}`);
    }
    for (const keyPoint of theme.key_tweets.slice(0, 1)) {
      enhancedLines.push(`  補足: ${keyPoint}`);
    }
  }

  enhancedLines.push("", "【注目銘柄】");
  if (result.stock_picks.length === 0) {
    enhancedLines.push("- 本命候補なし。弱い根拠での補完は行っていません。");
  } else {
    for (const pick of result.stock_picks) {
      enhancedLines.push(`- ${pick.rank}. ${pick.name}(${pick.code}) confidence=${pick.confidence}/10`);
      if (pick.root_theme) enhancedLines.push(`  根拠テーマ: ${pick.root_theme}`);
      enhancedLines.push(`  連想経路: ${pick.chain}`);
      enhancedLines.push(`  理由: ${pick.reasoning}`);
      if ((pick.supporting_news ?? []).length > 0) {
        enhancedLines.push(`  根拠ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      enhancedLines.push(`  カタリスト: ${pick.catalyst}`);
      enhancedLines.push(`  リスク: ${pick.risk}`);
    }
  }

  if ((result.watch_candidates ?? []).length > 0) {
    enhancedLines.push("", "【監視候補】");
    for (const pick of result.watch_candidates ?? []) {
      enhancedLines.push(`- ${pick.rank}. ${pick.name}(${pick.code}) watch=${pick.confidence}/10`);
      if (pick.root_theme) enhancedLines.push(`  注視テーマ: ${pick.root_theme}`);
      if ((pick.supporting_news ?? []).length > 0) {
        enhancedLines.push(`  起点ニュース: ${(pick.supporting_news ?? []).join(" / ")}`);
      }
      enhancedLines.push(`  監視理由: ${pick.reasoning}`);
      enhancedLines.push(`  次に確認: ${pick.catalyst}`);
      enhancedLines.push(`  留意点: ${pick.risk}`);
    }
  }

  enhancedLines.push("", "【市場センチメント】");
  enhancedLines.push(result.market_sentiment || "情報不足");

  if ((result.source_list ?? []).length > 0) {
    enhancedLines.push("", "【ソース一覧】");
    for (const source of (result.source_list ?? []).slice(0, 8)) {
      const meta = [source.source, source.timestamp ? formatPromptTimestamp(source.timestamp) : ""]
        .filter(Boolean)
        .join(" / ");
      enhancedLines.push(`- ${source.headline}${meta ? ` [${meta}]` : ""}`);
    }
  }

  enhancedLines.push("=".repeat(60));
  return enhancedLines.join("\n");
  const lines: string[] = [
    "=".repeat(60),
    `📊 株クラスタ分析レポート  ${result.analysis_date}`,
    "=".repeat(60),
    "",
    "【トレンドテーマ】",
  ];

  for (const theme of result.trending_themes) {
    lines.push(`  ▶ ${theme.theme}（言及: ${theme.mention_count} 件）`);
    for (const tw of theme.key_tweets.slice(0, 2)) {
      lines.push(`    - ${tw}`);
    }
  }

  lines.push("", "【注目銘柄（連想投資）】");

  for (const pick of result.stock_picks) {
    const conf  = "★".repeat(Math.round(pick.confidence / 2));
    const empty = "☆".repeat(5 - Math.round(pick.confidence / 2));
    lines.push(
      `  ${pick.rank}. ${pick.name}（${pick.code}）  確度: ${conf}${empty} ${pick.confidence}/10`
    );
    lines.push(`     経路: ${pick.chain}`);
    lines.push(`     理由: ${pick.reasoning}`);
    lines.push(`     カタリスト: ${pick.catalyst}`);
    lines.push(`     リスク: ${pick.risk}`);
    lines.push("");
  }

  lines.push("【市場センチメント】");
  lines.push(`  ${result.market_sentiment}`);
  lines.push("=".repeat(60));

  return lines.join("\n");
}
