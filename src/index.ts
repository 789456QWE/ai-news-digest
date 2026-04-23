import Anthropic from "@anthropic-ai/sdk";
import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import cron from "node-cron";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Article {
  title: string;
  link: string;
  publishedAt: Date;
  source: string;
  description: string; // raw text for AI context
  summary: string;     // AI-generated one-sentence Chinese summary
}

interface FeedSource {
  name: string;
  url: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const FEEDS: FeedSource[] = [
  {
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    name: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  },
  {
    name: "Hacker News",
    url: "https://hnrss.org/newest?q=AI&count=30",
  },
];

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const DESCRIPTION_MAX_LEN = 500; // chars sent to AI as context
const FETCH_TIMEOUT_MS = 8000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDescription(raw: unknown): string {
  if (!raw) return "";
  // Atom <content> or <summary> may be parsed as { "#text": "...", "@_type": "html" }
  const str =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null && "#text" in raw
      ? String((raw as Record<string, unknown>)["#text"] ?? "")
      : String(raw);
  const text = stripHtml(str);
  return text.length <= DESCRIPTION_MAX_LEN
    ? text
    : text.slice(0, DESCRIPTION_MAX_LEN) + "…";
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Fetch & Parse ───────────────────────────────────────────────────────────

async function fetchFeed(source: FeedSource): Promise<Article[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let xml: string;
  try {
    const res = await fetch(source.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml);

  // Support both RSS 2.0 (channel.item) and Atom (feed.entry)
  const channel = doc?.rss?.channel ?? doc?.feed;
  if (!channel) return [];

  const rawItems: unknown[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
    ? [channel.item]
    : Array.isArray(channel.entry)
    ? channel.entry
    : channel.entry
    ? [channel.entry]
    : [];

  const now = Date.now();
  const articles: Article[] = [];

  for (const item of rawItems) {
    const i = item as Record<string, unknown>;

    // Title
    const title = String(i.title ?? "").trim();
    if (!title) continue;

    // Link — RSS uses <link>, Atom uses <link href="..."> or string
    let link = "";
    if (typeof i.link === "string") {
      link = i.link.trim();
    } else if (i.link && typeof i.link === "object") {
      const l = i.link as Record<string, unknown>;
      link = String(l["@_href"] ?? l["#text"] ?? "").trim();
    }
    if (!link) continue;

    // Date — try multiple field names
    const rawDate =
      (i.pubDate as string | undefined) ??
      (i.published as string | undefined) ??
      (i.updated as string | undefined) ??
      (i["dc:date"] as string | undefined);
    const publishedAt = parseDate(rawDate);
    if (!publishedAt) continue;

    // Filter to last 24 h
    if (now - publishedAt.getTime() > TWENTY_FOUR_HOURS) continue;

    // Raw description for AI context (may be string or Atom object)
    const rawDesc =
      i.description ??
      i["content:encoded"] ??
      i.summary ??
      i.content;
    const description = extractDescription(rawDesc);

    articles.push({ title, link, publishedAt, source: source.name, description, summary: "" });
  }

  return articles;
}

// ─── AI Enrichment (translate title + summarize) ─────────────────────────────

interface EnrichItem {
  index: number;
  title: string;
  description: string;
}

interface EnrichResult {
  index: number;
  title: string;   // Chinese translation
  summary: string; // One-sentence Chinese summary
}

const ENRICH_BATCH_SIZE = 15;

/** Remove characters that commonly break JSON output from LLMs */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\x00-\x1F\x7F]/g, " ") // control characters
    .replace(/\\/g, "／")              // backslashes
    .replace(/"/g, "＂")              // double quotes
    .trim();
}

async function enrichBatch(
  client: Anthropic,
  batch: EnrichItem[]
): Promise<EnrichResult[]> {
  // Sanitize before embedding in prompt
  const safeBatch = batch.map((item) => ({
    ...item,
    title: sanitizeForPrompt(item.title),
    description: sanitizeForPrompt(item.description),
  }));

  const articleList = safeBatch
    .map(
      (item) =>
        `<<<${item.index}>>>\n标题：${item.title}\n描述：${item.description || "（无）"}`
    )
    .join("\n\n");

  const prompt = `你是一个 AI 科技新闻编辑，请处理以下新闻条目，对每条完成两件事：
1. 将标题翻译成中文（专有名词如公司名、产品名、人名保留英文）
2. 根据标题和描述，用一句话（不超过50字）写一个中文摘要

严格按以下格式逐条输出，不要有任何其他文字：
<<<编号>>>
T: 中文标题
S: 一句话摘要

新闻条目：
${articleList}`;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Parse the custom delimiter format
  const results: EnrichResult[] = [];
  const blocks = raw.split(/<<<(\d+)>>>/g);
  // blocks = ["", "15", "\nT: ...\nS: ...\n", "16", ...]
  for (let i = 1; i < blocks.length - 1; i += 2) {
    const index = parseInt(blocks[i], 10);
    const body = blocks[i + 1] ?? "";
    const titleMatch = body.match(/^T:\s*(.+)$/m);
    const summaryMatch = body.match(/^S:\s*(.+)$/m);
    if (titleMatch && summaryMatch) {
      results.push({
        index,
        title: titleMatch[1].trim(),
        summary: summaryMatch[1].trim(),
      });
    }
  }

  if (results.length === 0) {
    throw new Error(`无法解析响应，原始内容：${raw.slice(0, 200)}`);
  }

  return results;
}

async function enrichArticles(articles: Article[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("⚠ 未设置 ANTHROPIC_API_KEY，跳过 AI 处理，摘要留空。");
    return;
  }

  console.log("\n正在用 AI 翻译标题并生成摘要...");

  const client = new Anthropic({ apiKey });

  // Split into batches to avoid oversized responses
  const batches: EnrichItem[][] = [];
  for (let i = 0; i < articles.length; i += ENRICH_BATCH_SIZE) {
    batches.push(
      articles.slice(i, i + ENRICH_BATCH_SIZE).map((a, j) => ({
        index: i + j,
        title: a.title,
        description: a.description,
      }))
    );
  }

  let totalProcessed = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    process.stdout.write(`  批次 ${b + 1}/${batches.length}（${batch.length} 篇）... `);
    try {
      const results = await enrichBatch(client, batch);
      for (const r of results) {
        if (r.index >= 0 && r.index < articles.length) {
          articles[r.index].title = r.title;
          articles[r.index].summary = r.summary;
          totalProcessed++;
        }
      }
      console.log("✓");
    } catch (err) {
      console.log(`⚠ 失败，保留原文（${err instanceof Error ? err.message : err}）`);
    }
  }

  console.log(`✓ AI 处理完成（${totalProcessed} 篇）`);
}

// ─── Markdown Renderer ───────────────────────────────────────────────────────

function formatDateTime(date: Date): string {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderMarkdown(articles: Article[], successfulSources: Set<string>): string {
  const today = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const sourceCount = successfulSources.size;
  const sourceList = [...successfulSources].join(" / ");

  const lines: string[] = [
    `# AI 新闻日报 · ${today}`,
    "",
    `> 共收录 **${articles.length}** 篇，来自 **${sourceCount}** 个源（${sourceList}）`,
    `> 时间范围：过去 24 小时 | 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    "",
    "---",
    "",
  ];

  for (const article of articles) {
    lines.push(`### [${article.title}](${article.link})`);
    lines.push("");
    lines.push(
      `**${formatDateTime(article.publishedAt)}** · ${article.source}`
    );
    if (article.summary) {
      lines.push("");
      lines.push(`> ${article.summary}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("正在抓取 RSS 源...\n");

  // Fetch all feeds in parallel; failures are isolated
  const results = await Promise.allSettled(
    FEEDS.map((feed) =>
      fetchFeed(feed).then((articles) => ({ feed, articles }))
    )
  );

  const allArticles: Article[] = [];
  const successfulSources = new Set<string>();

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { feed, articles } = result.value;
      successfulSources.add(feed.name);
      console.log(`✓ ${feed.name}: ${articles.length} 篇`);
      allArticles.push(...articles);
    } else {
      // Find which feed failed by matching error context
      const failedFeed = FEEDS[results.indexOf(result)];
      console.error(`✗ ${failedFeed?.name ?? "未知源"}: ${result.reason}`);
    }
  }

  // Sort by time descending
  allArticles.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  console.log(`\n共收录 ${allArticles.length} 篇文章，来自 ${successfulSources.size} 个源`);

  if (allArticles.length === 0) {
    console.log("没有符合条件的文章，日报未生成。");
    return;
  }

  // Translate titles and generate AI summaries
  await enrichArticles(allArticles);

  // Write output
  const outputDir = join(process.cwd(), "output");
  await mkdir(outputDir, { recursive: true });

  const dateStr = new Date()
    .toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "-");

  const outputPath = join(outputDir, `${dateStr}.md`);
  const markdown = renderMarkdown(allArticles, successfulSources);
  await writeFile(outputPath, markdown, "utf-8");

  console.log(`\n日报已生成：${outputPath}`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const isCronMode = process.argv.includes("-cron");

if (isCronMode) {
  console.log("定时模式已启动，每天 08:00 (Asia/Shanghai) 自动生成日报");
  console.log("按 Ctrl+C 退出\n");

  // Run immediately on start so the first report isn't delayed until next 8 AM
  main().catch((err) => console.error("运行出错:", err));

  // Schedule: 0 8 * * * = every day at 08:00
  cron.schedule(
    "0 8 * * *",
    () => {
      console.log(`\n[${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}] 定时任务触发`);
      main().catch((err) => console.error("运行出错:", err));
    },
    { timezone: "Asia/Shanghai" }
  );
} else {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
