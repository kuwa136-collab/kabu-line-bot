import type { Post } from "../scraper/index.js";

export interface AnalysisResult {
  post: Post;
  summary: string;
  sentiment: "bullish" | "bearish" | "neutral";
  tickers: string[];
  importance: "high" | "medium" | "low";
  shouldNotify: boolean;
}
