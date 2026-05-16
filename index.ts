/**
 * pi-kimi-web-tools
 * Pi 扩展：将 Kimi CLI 的 SearchWeb / FetchURL 工具桥接到 Pi
 *
 * 基于 Kimi CLI 开源代码逆向的 API Schema：
 * - Search: POST https://api.kimi.com/coding/v1/search
 * - Fetch:  POST https://api.kimi.com/coding/v1/fetch
 *
 * 优点：
 * - 使用 Kimi 官方搜索/抓取服务，与 Kimi 模型对齐更好
 * - 统一 API Key，无需额外配置 Exa/Perplexity
 * - 中文搜索质量通常优于第三方服务
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── 配置 ──────────────────────────────────────────────────────────────

const SEARCH_URL = "https://api.kimi.com/coding/v1/search";
const FETCH_URL = "https://api.kimi.com/coding/v1/fetch";
const USER_AGENT = "KimiCLI/1.5";

// ─── API Key 读取 ──────────────────────────────────────────────────────

interface AuthJson {
  [provider: string]: {
    type: "api_key" | "oauth";
    key?: string;
    access?: string;
  };
}

function resolveKimiApiKey(): string | null {
  // 1. 环境变量优先
  const envKey =
    process.env.KIMI_API_KEY ||
    process.env.KIMI_CODING_API_KEY ||
    process.env.KIMI_CODE_API_KEY;
  if (envKey) return envKey;

  // 2. 从 auth.json 读取 kimi-coding 的 API Key
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth: AuthJson = JSON.parse(readFileSync(authPath, "utf-8"));
    const kimiCoding = auth["kimi-coding"];
    if (kimiCoding?.type === "api_key" && kimiCoding.key) {
      return kimiCoding.key;
    }
    // 兼容旧的 kimi-coder OAuth（理论上不用，但留作 fallback）
    const kimiCoder = auth["kimi-coder"];
    if (kimiCoder?.type === "api_key" && kimiCoder.key) {
      return kimiCoder.key;
    }
  } catch {
    // auth.json 不存在或解析失败
  }

  return null;
}

// ─── Search 工具 ───────────────────────────────────────────────────────

interface SearchResult {
  site_name: string;
  title: string;
  url: string;
  snippet: string;
  content: string;
  date: string;
  icon: string;
  mime: string;
}

interface SearchResponse {
  search_results: SearchResult[];
}

async function callKimiSearch(
  apiKey: string,
  query: string,
  limit: number,
  includeContent: boolean
): Promise<SearchResponse> {
  const toolCallId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": USER_AGENT,
      "X-Msh-Tool-Call-Id": toolCallId,
    },
    body: JSON.stringify({
      text_query: query,
      limit: limit,
      enable_page_crawling: includeContent,
      timeout_seconds: 30,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Kimi search failed: HTTP ${response.status} ${response.statusText}\n${text}`
    );
  }

  return (await response.json()) as SearchResponse;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "未找到搜索结果。";
  }

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i > 0) lines.push("---\n");
    lines.push(`**[${i + 1}] ${r.title}**`);
    lines.push(`URL: ${r.url}`);
    if (r.date) lines.push(`Date: ${r.date}`);
    if (r.site_name) lines.push(`Source: ${r.site_name}`);
    lines.push(`Summary: ${r.snippet}`);
    if (r.content) {
      lines.push("");
      lines.push(r.content);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Fetch 工具 ────────────────────────────────────────────────────────

/**
 * 尝试美化/解码返回内容
 * - JSON 内容：格式化并解码 \uXXXX Unicode 转义
 * - 文本内容：解码 \uXXXX 序列
 */
function prettifyContent(content: string): string {
  const trimmed = content.trim();

  // 如果看起来像 JSON，尝试格式化（JSON.parse 会自动解码 \uXXXX）
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // 不是有效的 JSON，继续下面的文本处理
    }
  }

  // 解码文本中的 \uXXXX Unicode 转义序列
  return content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/** 本地 HTTP fallback 抓取（当 Kimi fetch 服务失败时使用） */
async function fetchWithHttpGet(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s 超时

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": (
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    // 如果是纯文本或 markdown，直接返回
    if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
      return prettifyContent(text);
    }

    // 简单 HTML 到文本的转换（去除 script/style 标签，保留文本）
    return prettifyContent(
      text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    ).slice(0, 50000); // 限制 50KB
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function callKimiFetch(apiKey: string, url: string): Promise<string> {
  const toolCallId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s 总超时

  try {
    const response = await fetch(FETCH_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
        "Accept": "text/markdown",
        "X-Msh-Tool-Call-Id": toolCallId,
      },
      body: JSON.stringify({ url }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      // Kimi 服务对某些域名（如 github.com、moonshot.cn）返回 500
      // fallback 到本地 HTTP 抓取
      if (response.status >= 500) {
        console.warn(`[pi-kimi-web-tools] Kimi fetch service returned ${response.status} for ${url}, falling back to local HTTP GET`);
        return await fetchWithHttpGet(url);
      }
      throw new Error(
        `Kimi fetch failed: HTTP ${response.status} ${response.statusText}\n${text}`
      );
    }

    return prettifyContent(await response.text());
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      // 超时 fallback 到本地 HTTP
      console.warn(`[pi-kimi-web-tools] Kimi fetch timeout for ${url}, falling back to local HTTP GET`);
      return await fetchWithHttpGet(url);
    }
    throw e;
  }
}

// ─── 扩展入口 ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const apiKey = resolveKimiApiKey();

  if (!apiKey) {
    console.warn(
      "[pi-kimi-web-tools] 未找到 Kimi API Key。" +
        "请设置 KIMI_API_KEY 环境变量，或确保 ~/.pi/agent/auth.json 中有 kimi-coding 的 api_key。"
    );
    return;
  }

  // ── SearchWeb 工具 ──────────────────────────────────────────────────
  pi.registerTool({
    name: "SearchWeb",
    label: "Search Web",
    description:
      "Search the web using Kimi's official search service. " +
      "Returns a list of search results with title, URL, date, summary, and optionally full page content. " +
      "Use this tool when you need up-to-date information, current events, documentation, " +
      "or facts that may not be in your training data.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use SearchWeb when the user asks about current events, recent news, or information that may have changed since your knowledge cutoff.",
      "Use SearchWeb when you need to verify facts, find documentation, or look up specific technical details.",
      "Prefer concise, specific queries. If results don't contain what you need, try a more concrete query rather than increasing limit.",
      "Avoid enabling include_content when limit is large, as it consumes a large amount of tokens.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "The search query text. Be specific and concise. Use keywords rather than full sentences when possible.",
      }),
      limit: Type.Optional(
        Type.Integer({
          description:
            "Number of results to return (1-20). Default is 5. " +
            "You typically do not need to set this value.",
          minimum: 1,
          maximum: 20,
          default: 5,
        })
      ),
      include_content: Type.Optional(
        Type.Boolean({
          description:
            "Whether to include the full content of web pages in results. " +
            "Consumes a large amount of tokens. Only enable when you need detailed content from the pages.",
          default: false,
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Searching: ${params.query}...` }],
      });

      const data = await callKimiSearch(
        apiKey,
        params.query,
        params.limit ?? 5,
        params.include_content ?? false
      );

      const formatted = formatSearchResults(data.search_results);

      return {
        content: [{ type: "text", text: formatted }],
        details: {
          result_count: data.search_results.length,
          query: params.query,
        },
      };
    },
  });

  // ── FetchURL 工具 ───────────────────────────────────────────────────
  pi.registerTool({
    name: "FetchURL",
    label: "Fetch URL",
    description:
      "Fetch the content of a web page using Kimi's official fetch service. " +
      "Returns the main content extracted from the page in markdown format. " +
      "Use this tool when you need to read a specific web page, documentation, " +
      "article, or any URL that the user references.",
    promptSnippet: "Fetch and extract content from a web page URL",
    promptGuidelines: [
      "Use FetchURL when the user provides a URL and asks you to read or summarize its content.",
      "Use FetchURL when SearchWeb results reference a page you need to examine in detail.",
      "FetchURL returns the main text content extracted from the page, not raw HTML.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The full URL of the web page to fetch. Must include the protocol (http:// or https://).",
      }),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Fetching: ${params.url}...` }],
      });

      const content = await callKimiFetch(apiKey, params.url);

      return {
        content: [{ type: "text", text: content }],
        details: {
          url: params.url,
          content_length: content.length,
        },
      };
    },
  });

  // ── /search 命令：手动搜索 ──────────────────────────────────────────
  pi.registerCommand("search", {
    description: "Search the web using Kimi official search",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /search <query>", "error");
        return;
      }

      ctx.ui.notify(`Searching: "${query}"...`, "info");
      try {
        const data = await callKimiSearch(apiKey, query, 5, false);
        const formatted = formatSearchResults(data.search_results);

        // 作为用户消息注入，让模型直接看到结果并继续对话
        pi.sendUserMessage(
          `Web search results for "${query}" (${data.search_results.length} results):\n\n${formatted}`,
          { deliverAs: "followUp" }
        );
      } catch (e: any) {
        ctx.ui.notify(`Search failed: ${e.message}`, "error");
      }
    },
  });

  // ── /fetch 命令：手动抓取 ────────────────────────────────────────────
  pi.registerCommand("fetch", {
    description: "Fetch a web page using Kimi official fetch",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /fetch <url>", "error");
        return;
      }
      // 自动补全协议头
      const targetUrl = url.startsWith("http") ? url : `https://${url}`;

      ctx.ui.notify(`Fetching: ${targetUrl}...`, "info");
      try {
        const content = await callKimiFetch(apiKey, targetUrl);
        const preview = content.length > 3000
          ? content.slice(0, 3000) + "\n\n... (truncated, total " + content.length + " chars)"
          : content;

        pi.sendUserMessage(
          `Fetched content from ${targetUrl}:\n\n${preview}`,
          { deliverAs: "followUp" }
        );
      } catch (e: any) {
        ctx.ui.notify(`Fetch failed: ${e.message}`, "error");
      }
    },
  });

  // ── /kimi-web-update 命令：自动更新 ─────────────────────────────────
  pi.registerCommand("kimi-web-update", {
    description: "Update pi-kimi-web-tools to latest version from GitHub",
    handler: async (_args, ctx) => {
      try {
        const { execSync } = await import("node:child_process");
        const output = execSync("git pull origin main", {
          cwd: __dirname,
          encoding: "utf-8",
          timeout: 30000,
        });
        ctx.ui.notify(`✅ Updated:\n${output.trim()}`, "success");
        ctx.ui.notify("Run /reload to apply changes", "info");
      } catch (e: any) {
        const stderr = e.stderr || e.message || String(e);
        ctx.ui.notify(`❌ Update failed:\n${stderr}`, "error");
      }
    },
  });

  // ── /kimi-web 命令：查看状态 ─────────────────────────────────────────
  pi.registerCommand("kimi-web", {
    description: "Show pi-kimi-web-tools status",
    handler: async (_args, ctx) => {
      const maskedKey = apiKey.length > 12
        ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`
        : "***";
      ctx.ui.notify(
        `pi-kimi-web-tools active\nAPI Key: ${maskedKey}\nTools: SearchWeb, FetchURL\nCommands: /search, /fetch, /kimi-web-update`,
        "info"
      );
    },
  });

  console.log("[pi-kimi-web-tools] Loaded: SearchWeb + FetchURL + /search + /fetch + /kimi-web-update (Kimi official)");
}
