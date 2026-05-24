/**
 * Kimi Provider — 满足 rpiv-web-tools 的 SearchProvider 接口
 *
 * 将 pi-kimi-web-tools 的 Kimi API 调用逻辑提取为独立的 Provider 实现，
 * 可通过 Patch 工具注入到 @juicesharp/rpiv-web-tools 的 Provider 系统中。
 *
 * 设计约束：
 * - 不 import 任何 rpiv 类型，依赖 TypeScript structural typing 兼容
 * - 多源 API key 自动解析（env var + auth.json）
 * - search() 默认关闭页面抓取（enable_page_crawling: false），因 rpiv SearchProvider 接口无 includeContent 参数
 * - fetch() 先调用 Kimi /fetch 端点，500/timeout/网络断开 时 fallback 到本地 HTTP
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SEARCH_URL = "https://api.kimi.com/coding/v1/search";
const FETCH_URL = "https://api.kimi.com/coding/v1/fetch";
const USER_AGENT = "KimiCLI/1.5";

// ---------------------------------------------------------------------------
// 本地兼容类型（structural typing，与 rpiv-web-tools/providers/types.ts 兼容）
// ---------------------------------------------------------------------------

/** rpiv ProviderConfigUi 接口的本地兼容定义 */
interface ProviderConfigUi {
	input(label: string, placeholder: string): Promise<string | null | undefined>;
}

/** rpiv ProviderConfigCurrent 接口的本地兼容定义 */
interface ProviderConfigCurrent {
	apiKey?: string;
	baseUrl?: string;
}

/** rpiv ProviderConfigChange 接口的本地兼容定义 */
interface ProviderConfigChange {
	apiKey?: string | null;
	baseUrl?: string | null;
}

/** rpiv SearchResult 接口的本地兼容定义 */
interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** rpiv SearchResponse 接口的本地兼容定义 */
interface SearchResponse {
	query: string;
	results: SearchResult[];
}

/** rpiv FetchResponse 接口的本地兼容定义 */
interface FetchResponse {
	text: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
}

// ---------------------------------------------------------------------------
// 本地辅助：判断用户是否取消了输入
// ---------------------------------------------------------------------------

function isCancellation(
	input: string | null | undefined,
): input is null | undefined {
	return input == null;
}

// ---------------------------------------------------------------------------
// API Key 多源解析
// ---------------------------------------------------------------------------

interface AuthJson {
	[provider: string]: {
		type: "api_key" | "oauth";
		key?: string;
		access?: string;
	};
}

/**
 * 多源 API Key 解析
 *
 * 解析顺序（第一个非空值胜出）：
 * 1. KIMI_API_KEY 环境变量
 * 2. KIMI_CODING_API_KEY 环境变量
 * 3. KIMI_CODE_API_KEY 环境变量
 * 4. ~/.pi/agent/auth.json → kimi-coding.api_key
 * 5. ~/.pi/agent/auth.json → kimi-coder.api_key
 *
 * @returns 解析到的 API Key，或 null
 */
export function resolveKimiApiKey(): string | null {
	// 环境变量优先
	const envKey =
		process.env.KIMI_API_KEY?.trim() ||
		process.env.KIMI_CODING_API_KEY?.trim() ||
		process.env.KIMI_CODE_API_KEY?.trim();
	if (envKey) return envKey;

	// auth.json fallback
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const auth: AuthJson = JSON.parse(readFileSync(authPath, "utf-8"));

		const kimiCoding = auth["kimi-coding"];
		if (kimiCoding?.type === "api_key" && kimiCoding.key) {
			return kimiCoding.key.trim();
		}

		const kimiCoder = auth["kimi-coder"];
		if (kimiCoder?.type === "api_key" && kimiCoder.key) {
			return kimiCoder.key.trim();
		}
	} catch {
		// auth.json 不存在或格式错误，静默忽略
	}

	return null;
}

// ---------------------------------------------------------------------------
// Kimi API 响应类型
// ---------------------------------------------------------------------------

interface KimiSearchItem {
	site_name?: string;
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	date?: string;
	icon?: string;
	mime?: string;
}

interface KimiSearchApiResponse {
	search_results?: KimiSearchItem[];
}

// ---------------------------------------------------------------------------
// 结果格式化（与现有 pi-kimi-web-tools 行为一致）
// ---------------------------------------------------------------------------

/**
 * 将 Kimi 搜索结果格式化为 Markdown 文本
 *
 * @param results 搜索结果数组
 * @returns Markdown 格式的结果文本
 */
export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) {
		return "未找到搜索结果。";
	}

	const lines: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (i > 0) lines.push("---\n");
		lines.push(`**[${i + 1}] ${r.title}**`);
		lines.push(`URL: ${r.url}`);
		lines.push(`Summary: ${r.snippet}`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * 解码常见 HTML 实体
 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 美化/解码返回内容
 * - JSON 内容：格式化并解码 \uXXXX Unicode 转义
 * - 文本内容：解码 \uXXXX 序列
 */
function prettifyContent(content: string): string {
	const trimmed = content.trim();

	// JSON 内容：格式化
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			const parsed = JSON.parse(trimmed);
			return JSON.stringify(parsed, null, 2);
		} catch {
			// 不是有效 JSON，继续文本处理
		}
	}

	// 文本内容：解码 Unicode 转义
	return content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
		String.fromCharCode(parseInt(hex, 16)),
	);
}

// ---------------------------------------------------------------------------
// 本地 HTTP fallback（当 Kimi fetch 服务失败时使用）
// ---------------------------------------------------------------------------

/**
 * 本地 HTTP GET fallback
 *
 * 当 Kimi /fetch 端点返回 500 或超时时，直接抓取目标 URL 并做简单的 HTML 剥离。
 *
 * @param url 目标 URL
 * @returns 纯文本内容
 */
async function fetchWithHttpGet(url: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30000);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
					"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});

		if (!response.ok) {
			clearTimeout(timeout);
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") || "";
		const text = await response.text();
		clearTimeout(timeout);

		// 纯文本/Markdown 直接返回
		if (
			contentType.includes("text/plain") ||
			contentType.includes("text/markdown")
		) {
			return prettifyContent(text);
		}

		// HTML 内容：简单剥离标签并解码实体
		return prettifyContent(
			decodeHtmlEntities(
				text
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			),
		).slice(0, 50000);
	} catch (e) {
		clearTimeout(timeout);
		throw e;
	}
}

// ---------------------------------------------------------------------------
// KimiProvider 类
// ---------------------------------------------------------------------------

export class KimiProvider {
	readonly name = "kimi";
	readonly label = "Kimi";
	readonly envVar = "KIMI_API_KEY";

	private readonly apiKey: string;

	/**
	 * 构造函数：优先使用传入的 apiKey，否则自动多源解析
	 *
	 * @param apiKey 可选的外部传入 key（如从 config.apiKeys.kimi 读取）
	 */
	constructor(apiKey?: string) {
		// 优先使用传入的 key（如用户通过 /web-search-config 配置的 key）
		// 否则自动解析多源 key
		this.apiKey = apiKey?.trim() || resolveKimiApiKey() || "";
	}

	// ---------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------

	/**
	 * 调用 Kimi 搜索 API
	 *
	 * 注意：rpiv SearchProvider 接口无 includeContent 参数，
	 * 因此 enable_page_crawling 固定为 false。
	 * site_name 和 date 信息被拼接进 snippet 以保留。
	 *
	 * @param query 搜索查询
	 * @param maxResults 最大结果数
	 * @param signal AbortSignal
	 * @returns 标准化的搜索结果
	 */
	async search(
		query: string,
		maxResults: number,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		if (!this.apiKey) {
			throw new Error(
				`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`,
			);
		}

		const toolCallId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const res = await fetch(SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
				"User-Agent": USER_AGENT,
				"X-Msh-Tool-Call-Id": toolCallId,
			},
			body: JSON.stringify({
				text_query: query,
				limit: maxResults,
				enable_page_crawling: false, // rpiv 接口不支持 includeContent
				timeout_seconds: 30,
			}),
			signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(
				`${this.label} Search API error (${res.status}): ${text}`,
			);
		}

		const raw = (await res.json()) as KimiSearchApiResponse;
		const items = raw.search_results ?? [];

		// 映射到 SearchResult：将 site_name 和 date 拼接进 snippet 以保留信息
		const results: SearchResult[] = items.map((item) => {
			const parts: string[] = [];
			if (item.site_name) parts.push(`[${item.site_name}]`);
			if (item.date) parts.push(`(${item.date})`);
			if (item.snippet) parts.push(item.snippet);
			return {
				title: item.title ?? "",
				url: item.url ?? "",
				snippet: parts.join(" ") || "",
			};
		});

		return { query, results };
	}

	// ---------------------------------------------------------------------------
	// Fetch
	// ---------------------------------------------------------------------------

	/**
	 * 调用 Kimi 抓取 API
	 *
	 * 策略：
	 * 1. 先尝试 Kimi /fetch 端点（返回 Markdown）
	 * 2. 若返回 500、超时或网络断开，fallback 到本地 HTTP GET + HTML 剥离
	 *
	 * @param url 目标 URL
	 * @param _raw 是否返回原始内容（Kimi 端点始终返回 Markdown，此参数仅影响 fallback）
	 * @param signal AbortSignal
	 * @returns 抓取内容
	 */
	async fetch(
		url: string,
		_raw: boolean,
		signal?: AbortSignal,
	): Promise<FetchResponse> {
		// 有 API Key 时优先尝试 Kimi 端点
		if (this.apiKey) {
			try {
				return await this.fetchNative(url, signal);
			} catch (err) {
				const isRetryable =
					err instanceof Error &&
					(/5\d\d/.test(err.message) ||
						err.name === "AbortError" ||
						err.message.includes("timeout") ||
						err.message.includes("ECONNREFUSED") ||
						err.message.includes("ENOTFOUND") ||
						err.message.includes("ETIMEDOUT") ||
						err.message.includes("fetch failed") ||
						err.message.includes("getaddrinfo"));
				if (!isRetryable) throw err;
				// 5xx / timeout / 网络断开 → fallback 到本地 HTTP
				console.warn(
					`[KimiProvider] Kimi fetch service failed for ${url}, falling back to local HTTP GET`,
				);
			}
		}

		// 本地 HTTP fallback（与现有 pi-kimi-web-tools 行为一致）
		const text = await fetchWithHttpGet(url);
		return {
			text,
			contentType: "text/plain",
			contentLength: text.length,
		};
	}

	/**
	 * 调用 Kimi 原生 /fetch 端点
	 */
	private async fetchNative(
		url: string,
		signal?: AbortSignal,
	): Promise<FetchResponse> {
		const toolCallId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);

		let mergedSignal: AbortSignal = controller.signal;
		let signalListener: (() => void) | undefined;
		let controllerListener: (() => void) | undefined;

		if (signal) {
			const merged = new AbortController();
			signalListener = () => merged.abort();
			controllerListener = () => merged.abort();
			signal.addEventListener("abort", signalListener);
			controller.signal.addEventListener("abort", controllerListener);
			mergedSignal = merged.signal;
		}

		try {
			const res = await fetch(FETCH_URL, {
				method: "POST",
				signal: mergedSignal,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
					"User-Agent": USER_AGENT,
					Accept: "text/markdown",
					"X-Msh-Tool-Call-Id": toolCallId,
				},
				body: JSON.stringify({ url }),
			});

			if (!res.ok) {
				clearTimeout(timeout);
				const text = await res.text();
				throw new Error(
					`${this.label} Fetch API error (${res.status}): ${text}`,
				);
			}

			const markdown = prettifyContent(await res.text());
			clearTimeout(timeout);
			return {
				text: markdown,
				contentType: "text/markdown",
				contentLength: markdown.length,
			};
		} catch (e: any) {
			clearTimeout(timeout);
			if (e.name === "AbortError") {
				throw new Error(`${this.label} Fetch API timeout for ${url}`);
			}
			throw e;
		} finally {
			if (signal && signalListener)
				signal.removeEventListener("abort", signalListener);
			if (controllerListener)
				controller.signal.removeEventListener("abort", controllerListener);
		}
	}
}

// ---------------------------------------------------------------------------
// /web-search-config 配置辅助
// ---------------------------------------------------------------------------

const MASK_VISIBLE_CHARS = 4;

function maskKey(key: string): string {
	const head = key.slice(0, MASK_VISIBLE_CHARS);
	const tail = key.slice(-MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

async function promptForKey(
	ui: ProviderConfigUi,
	current: string | undefined,
): Promise<string | null | undefined> {
	const existing = current?.trim() || undefined;
	const input = await ui.input(
		"Kimi API key",
		existing
			? `Press Enter to keep current (${maskKey(existing)}), or type new key`
			: "Press Enter to leave unset, or type a key",
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || null;
}

/**
 * Kimi Provider 配置回调
 *
 * 供 /web-search-config 命令调用，提示用户输入 API key。
 * 返回 null 表示用户取消；返回 { apiKey } 表示保存配置。
 */
export async function configureKimi(
	ui: ProviderConfigUi,
	current: ProviderConfigCurrent,
): Promise<ProviderConfigChange | null> {
	const apiKey = await promptForKey(ui, current.apiKey);
	if (apiKey === undefined) return null; // 用户取消
	return { apiKey };
}

// ---------------------------------------------------------------------------
// Provider Meta
// ---------------------------------------------------------------------------

/**
 * Kimi Provider 元数据
 *
 * 注入到 rpiv-web-tools 的 PROVIDERS 数组中使用。
 * 结构上与 rpiv ProviderMeta 接口兼容（structural typing）。
 */
export const KIMI_PROVIDER_META = {
	name: "kimi" as const,
	label: "Kimi" as const,
	envVar: "KIMI_API_KEY" as const,
	configure: (ui: ProviderConfigUi, current: ProviderConfigCurrent) =>
		configureKimi(ui, current),
} as const;
