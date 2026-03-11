import * as line from "@line/bot-sdk";
import type { AnalysisResult } from "../analyzer/analysisResult.js";

const clientConfig: line.ClientConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
};

const client = new line.messagingApi.MessagingApiClient(clientConfig);

const SENTIMENT_LABEL: Record<string, string> = {
  bullish: "📈 強気",
  bearish: "📉 弱気",
  neutral: "➡️ 中立",
};

const IMPORTANCE_LABEL: Record<string, string> = {
  high: "🔴 重要度: 高",
  medium: "🟡 重要度: 中",
  low: "🟢 重要度: 低",
};

/**
 * 分析結果を LINE Flex Message に変換して送信
 */
export async function sendAnalysisResult(
  result: AnalysisResult,
  groupId: string
): Promise<void> {
  const { post, summary, sentiment, tickers, importance } = result;
  const tickerText =
    tickers.length > 0 ? `銘柄: ${tickers.join(", ")}` : "銘柄: 特定なし";
  const timeText = post.publishedAt.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });

  const flexMessage = {
    type: "flex",
    altText: `【株情報】${post.author}: ${summary}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `@${post.author}`,
            weight: "bold",
            size: "sm",
            color: "#1DA1F2",
          },
          {
            type: "text",
            text: timeText,
            size: "xs",
            color: "#888888",
          },
        ],
        backgroundColor: "#F0F8FF",
        paddingAll: "12px",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: summary,
            wrap: true,
            size: "sm",
          },
          {
            type: "separator",
          },
          {
            type: "text",
            text: tickerText,
            size: "xs",
            color: "#555555",
          },
          {
            type: "text",
            text: SENTIMENT_LABEL[sentiment] ?? sentiment,
            size: "xs",
          },
          {
            type: "text",
            text: IMPORTANCE_LABEL[importance] ?? importance,
            size: "xs",
          },
        ],
        paddingAll: "12px",
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "元投稿を見る",
              uri: post.url,
            },
            style: "link",
            height: "sm",
          },
        ],
        paddingAll: "4px",
      },
    },
  };

  await client.pushMessage({
    to: groupId,
    messages: [flexMessage as unknown as line.messagingApi.Message],
  });
}

/**
 * 複数の分析結果を一括送信（重要度 high のみ）
 */
export async function broadcastHighImportance(
  results: AnalysisResult[],
  groupId: string
): Promise<void> {
  const targets = results.filter((r) => r.shouldNotify);
  for (const result of targets) {
    await sendAnalysisResult(result, groupId);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(
    `[line] ${targets.length}/${results.length} 件を LINE 送信しました`
  );
}
