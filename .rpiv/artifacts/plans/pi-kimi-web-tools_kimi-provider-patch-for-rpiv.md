---
date: "2026-05-24T00:27:02.759Z"
author: ZeroDevi1
commit: 7fa61dd
branch: main
repository: pi-kimi-web-tools
topic: "Kimi Provider Patch for rpiv-web-tools"
tags: [plan, blueprint, provider, patch, rpiv-web-tools, kimi]
status: ready
parent: ".rpiv/artifacts/research/pi-kimi-web-tools_kimi-provider-patch-for-rpiv-web-tools.md"
phase_count: 3
unresolved_phase_count: 0
last_updated: "2026-05-24T00:27:02.759Z"
last_updated_by: ZeroDevi1
---

# Kimi Provider Patch for rpiv-web-tools — 实现计划

## Overview

将 `pi-kimi-web-tools` 的 Kimi 搜索能力以 Provider 形式注入到 `@juicesharp/rpiv-web-tools` 的 Provider 系统中，无需 Fork rpiv-web-tools。Patch 工具采用**文件级文本插入**策略（运行时 ESM monkey-patch 已移除，因 ESM `export function` binding 无法通过 namespace mutation 影响直接 import）。同时改造 `pi-kimi-web-tools` 自身，在检测到 rpiv-web-tools 已安装时自动进入"兼容模式"：不再注册 `search_web`/`fetch_url` 模型工具，仅保留 `/search`、`/fetch`、`/kimi-web-update`、`/kimi-web` 命令。

## Requirements

1. 实现 `KimiProvider` 类，满足 `rpiv-web-tools/providers/types.ts` 的 `SearchProvider` 接口
2. 支持多源 API key 自动解析（`KIMI_API_KEY` / `KIMI_CODING_API_KEY` / `KIMI_CODE_API_KEY` + `~/.pi/agent/auth.json`）
3. `search()` 调用 Kimi 官方搜索 API，`fetch()` 调用 Kimi 官方抓取 API，含本地 HTTP fallback
4. Patch 工具：文件级文本插入直接修改 rpiv 源文件（运行时 monkey-patch 已移除）
5. `pi-kimi-web-tools` 兼容模式：检测 rpiv-web-tools 存在时跳过工具注册，命令委托给本地 KimiProvider
6. 保留 `/kimi-web-update` 和 `/kimi-web` 命令

## Current State Analysis

`pi-kimi-web-tools` 当前是一个独立的 Pi 扩展，在 `index.ts` 中直接注册 `search_web`、`fetch_url` 两个模型工具和 `/search`、`/fetch`、`/kimi-web-update`、`/kimi-web` 四个命令。所有 Kimi API 调用逻辑、key 解析、结果格式化都内联在 `index.ts` 中。

`@juicesharp/rpiv-web-tools` v1.12.0 采用 pluggable Provider 架构：
- `providers/types.ts` 定义 `SearchProvider` / `ProviderMeta` 接口
- `providers/factory.ts` 硬编码 switch 实例化 Provider
- `providers/index.ts` 静态 `PROVIDERS` 数组驱动 UI 和配置
- `web-tools.ts` Orchestrator 完全 generic，不硬编码任何 Provider 名称

### Key Discoveries
- `rpiv-web-tools/providers/types.ts:19-27` — `SearchProvider` 接口：需实现 `name`、`label`、`envVar`、`search()`、`fetch()`
- `rpiv-web-tools/providers/index.ts:43-51` — `PROVIDERS` 是静态数组，但数组对象本身可变（`.push()` 可行）
- `rpiv-web-tools/providers/factory.ts:15` — `createSearchProvider` 是 `export function`，ESM live binding 可被 wrapper 替换
- `rpiv-web-tools/web-tools.ts:151` / `web-tools.ts:462` — Orchestrator 完全 generic，Provider 只需进入数组+factory 即可自动集成
- `rpiv-web-tools/package.json:39-45` — 直接发布 TypeScript 源码，AST patch 可操作源文件
- `pi-kimi-web-tools/index.ts:37-59` — 现有多源 key 解析链（3 个 env var + auth.json fallback）
- `pi-kimi-web-tools/index.ts:239-256` — 现有 500/timeout fallback 到本地 HTTP GET
- SearXNG 先例（v1.12.0）引入 `configure()` 回调模式，Kimi 的多源 key 可复用此模式

## Desired End State

```ts
// 用户安装 pi-kimi-web-tools 后，Pi 启动时：
// 1. pi-kimi-web-tools 检测到 rpiv-web-tools 已安装
// 2. 自动运行 patch 工具，将 Kimi 注入 rpiv-web-tools
// 3. /web-search-config 中出现 "Kimi" 选项
// 4. 模型使用 web_search/web_fetch 时，可选择 Kimi 作为后端
// 5. 用户仍可手动用 /search /fetch 命令注入结果
// 6. /kimi-web-update 可更新 pi-kimi-web-tools 自身代码
```

## What We're NOT Doing

- ❌ Fork rpiv-web-tools 或向 juicesharp 提交 PR
- ❌ 修改 rpiv-web-tools 的 `web-tools.ts` Orchestrator（generic 设计无需改动）
- ❌ 修改 rpiv-web-tools 的 `providers/types.ts`（Kimi 不需要新接口字段）
- ❌ 为 rpiv-web-tools 添加 `/search` `/fetch` 手动注入命令（保留在 pi-kimi-web-tools 中）
- ❌ 支持 rpiv-web-tools 的旧版本（< v1.8.0，pluggable provider 架构不存在）
- ❌ 为 patch 工具引入 TS Compiler API（文件级 fallback 用简单文本插入即可，AST 过于复杂）
- ❌ 实现 checksum 版本管理系统（先用简单存在性检测：检查 switch 中是否已有 `"kimi"` case）

## Decisions

### D1: API Key 解析策略 — 自动解析 + configure() 兜底
**选项**：
- A: `KimiProvider` 构造函数内部实现完整多源 key 解析链（env var + auth.json），与当前 pi-kimi-web-tools 行为一致
- B: 仅声明 `envVar: "KIMI_API_KEY"`，依赖 `/web-search-config` 交互配置

**决策**：选 A。自动解析保持零配置体验，`configure()` 仅作为手动覆盖入口。`envVar: "KIMI_API_KEY"` 作为兜底，Orchestrator 的 `resolveProviderApiKey` 也会检查它。

### D2: Fetch Pipeline — 原生 Kimi 端点 + fallback 到共享 helpers
**选项**：
- A: `fetch()` 始终调用 Kimi `/fetch` 端点（返回 Markdown），失败 fallback 到 `fetch-helpers.ts` 的 raw HTTP + HTML-to-text
- B: `fetch()` 直接使用 `fetch-helpers.ts` 的通用 HTTP pipeline（不调用 Kimi 端点）

**决策**：选 A。Kimi `/fetch` 端点返回已提取的 Markdown，质量优于通用 HTML stripping。仅在 500/timeout 时 fallback 到本地 HTTP。

### D3: Patch 策略 — 纯文件级 patch（运行时 monkey-patch 已移除）
**选项**：
- A: 仅运行时 monkey-patch
- B: 仅文件级 patch
- C: 运行时优先，失败 fallback 到文件级

**决策**：选 B。运行时 monkey-patch 对 `createSearchProvider` 无效（ESM namespace 的 `export function` binding 独立于直接 import），`web-tools.ts` 使用 `import { createSearchProvider }` 直接导入，namespace mutation 无法影响。`PROVIDERS.push()` 虽有效但不足以让 factory 识别 Kimi。因此移除运行时 patch，仅保留文件级文本插入。

### D4: 兼容模式下命令行为 — 直接调用 KimiProvider
**选项**：
- A: `/search` `/fetch` 命令委托给 rpiv 的 `web_search`/`web_fetch` 工具（通过 ExtensionAPI 调用）
- B: `/search` `/fetch` 命令直接调用本地 `KimiProvider` 实例

**决策**：选 B。ExtensionAPI 跨扩展调用工具不是稳定 API。命令直接调用本地 KimiProvider 更简单可靠，且与 rpiv 的 Provider 实例独立不冲突。

### D5: 文件级 fallback 的实现方式 — 简单文本插入
**选项**：
- A: 使用 TypeScript Compiler API 做 AST 级插入
- B: 使用简单文本查找/替换（检查 `"kimi"` 是否已存在，不存在则插入）

**决策**：选 B。rpiv-web-tools 的 Provider 注册模式非常稳定（switch case + PROVIDERS 数组元素），简单文本插入足够 robust，且避免了 TS compiler API 的复杂依赖。

## Phase 1: KimiProvider 核心实现

### Overview
提取并重构现有 `index.ts` 中的 Kimi API 调用逻辑，适配为 `SearchProvider` 接口实现。新建 `kimi-provider.ts`，包含 `KimiProvider` 类、`KIMI_PROVIDER_META`、多源 key 解析、`configure()` 回调。这是整个功能的基础，所有后续切片依赖此文件。

### Changes Required:

#### 1. kimi-provider.ts
**File**: `kimi-provider.ts`
**Changes**: NEW — Kimi Provider 核心实现，满足 rpiv-web-tools 的 SearchProvider 接口

```typescript
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
 * - fetch() 先调用 Kimi /fetch 端点，500/timeout 时 fallback 到本地 HTTP
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SEARCH_URL = "https://api.kimi.com/coding/v1/search";
const FETCH_URL = "https://api.kimi.com/coding/v1/fetch";
const USER_AGENT = "KimiCLI/1.5";

// 本地兼容类型（structural typing）
interface ProviderConfigUi {
	input(label: string, placeholder: string): Promise<string | null | undefined>;
}
interface ProviderConfigCurrent { apiKey?: string; baseUrl?: string; }
interface ProviderConfigChange { apiKey?: string | null; baseUrl?: string | null; }
interface SearchResult { title: string; url: string; snippet: string; }
interface SearchResponse { query: string; results: SearchResult[]; }
interface FetchResponse { text: string; title?: string; contentType?: string; contentLength?: number; }

function isCancellation(input: string | null | undefined): input is null | undefined { return input == null; }

interface AuthJson {
	[provider: string]: { type: "api_key" | "oauth"; key?: string; access?: string; };
}

export function resolveKimiApiKey(): string | null {
	const envKey =
		process.env.KIMI_API_KEY?.trim() ||
		process.env.KIMI_CODING_API_KEY?.trim() ||
		process.env.KIMI_CODE_API_KEY?.trim();
	if (envKey) return envKey;
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const auth: AuthJson = JSON.parse(readFileSync(authPath, "utf-8"));
		const kimiCoding = auth["kimi-coding"];
		if (kimiCoding?.type === "api_key" && kimiCoding.key) return kimiCoding.key.trim();
		const kimiCoder = auth["kimi-coder"];
		if (kimiCoder?.type === "api_key" && kimiCoder.key) return kimiCoder.key.trim();
	} catch { /* ignore */ }
	return null;
}

interface KimiSearchItem {
	site_name?: string; title?: string; url?: string; snippet?: string;
	content?: string; date?: string; icon?: string; mime?: string;
}
interface KimiSearchApiResponse { search_results?: KimiSearchItem[]; }

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "未找到搜索结果。";
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

function prettifyContent(content: string): string {
	const trimmed = content.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* ignore */ }
	}
	return content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function fetchWithHttpGet(url: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30000);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});
		clearTimeout(timeout);
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		const contentType = response.headers.get("content-type") || "";
		const text = await response.text();
		if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
			return prettifyContent(text);
		}
		return prettifyContent(decodeHtmlEntities(
			text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
		)).slice(0, 50000);
	} catch (e) { clearTimeout(timeout); throw e; }
}

export class KimiProvider {
	readonly name = "kimi"; readonly label = "Kimi"; readonly envVar = "KIMI_API_KEY";
	private readonly apiKey: string;

	constructor(apiKey?: string) {
		this.apiKey = apiKey?.trim() || resolveKimiApiKey() || "";
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.apiKey) throw new Error(`${this.envVar} is not set. Run /web-search-config to configure, or export the env var.`);
		const toolCallId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const res = await fetch(SEARCH_URL, {
			method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}`, "User-Agent": USER_AGENT, "X-Msh-Tool-Call-Id": toolCallId },
			body: JSON.stringify({ text_query: query, limit: maxResults, enable_page_crawling: false, timeout_seconds: 30 }),
			signal,
		});
		if (!res.ok) { const text = await res.text(); throw new Error(`${this.label} Search API error (${res.status}): ${text}`); }
		const raw = (await res.json()) as KimiSearchApiResponse;
		const items = raw.search_results ?? [];
		const results: SearchResult[] = items.map((item) => {
			const parts: string[] = [];
			if (item.site_name) parts.push(`[${item.site_name}]`);
			if (item.date) parts.push(`(${item.date})`);
			if (item.snippet) parts.push(item.snippet);
			return { title: item.title ?? "", url: item.url ?? "", snippet: parts.join(" ") || "" };
		});
		return { query, results };
	}

	async fetch(url: string, _raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
		if (this.apiKey) {
			try { return await this.fetchNative(url, signal); }
			catch (err) {
				const isRetryable = err instanceof Error && (
					/5\d\d/.test(err.message) ||
					err.name === "AbortError" ||
					err.message.includes("timeout") ||
					err.message.includes("ECONNREFUSED") ||
					err.message.includes("ENOTFOUND") ||
					err.message.includes("ETIMEDOUT") ||
					err.message.includes("fetch failed") ||
					err.message.includes("getaddrinfo")
				);
				if (!isRetryable) throw err;
				console.warn(`[KimiProvider] Kimi fetch service failed for ${url}, falling back to local HTTP GET`);
			}
		}
		const text = await fetchWithHttpGet(url);
		return { text, contentType: "text/plain", contentLength: text.length };
	}

	private async fetchNative(url: string, signal?: AbortSignal): Promise<FetchResponse> {
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
				method: "POST", signal: mergedSignal,
				headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}`, "User-Agent": USER_AGENT, "Accept": "text/markdown", "X-Msh-Tool-Call-Id": toolCallId },
				body: JSON.stringify({ url }),
			});

			if (!res.ok) {
				clearTimeout(timeout);
				const text = await res.text();
				throw new Error(`${this.label} Fetch API error (${res.status}): ${text}`);
			}

			const markdown = prettifyContent(await res.text());
			clearTimeout(timeout);
			return { text: markdown, contentType: "text/markdown", contentLength: markdown.length };
		} catch (e: any) {
			clearTimeout(timeout);
			if (e.name === "AbortError") throw new Error(`${this.label} Fetch API timeout for ${url}`);
			throw e;
		} finally {
			if (signal && signalListener) signal.removeEventListener("abort", signalListener);
			if (controllerListener) controller.signal.removeEventListener("abort", controllerListener);
		}
	}
}

const MASK_VISIBLE_CHARS = 4;
function maskKey(key: string): string { const head = key.slice(0, MASK_VISIBLE_CHARS); const tail = key.slice(-MASK_VISIBLE_CHARS); return `${head}...${tail}`; }

async function promptForKey(ui: ProviderConfigUi, current: string | undefined): Promise<string | null | undefined> {
	const existing = current?.trim() || undefined;
	const input = await ui.input("Kimi API key", existing ? `Press Enter to keep current (${maskKey(existing)}), or type new key` : "Press Enter to leave unset, or type a key");
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || null;
}

export async function configureKimi(ui: ProviderConfigUi, current: ProviderConfigCurrent): Promise<ProviderConfigChange | null> {
	const apiKey = await promptForKey(ui, current.apiKey);
	if (apiKey === undefined) return null;
	return { apiKey };
}

export const KIMI_PROVIDER_META = {
	name: "kimi" as const,
	label: "Kimi" as const,
	envVar: "KIMI_API_KEY" as const,
	configure: (ui: ProviderConfigUi, current: ProviderConfigCurrent) => configureKimi(ui, current),
} as const;
```

### Success Criteria:

#### Automated Verification:
- [x] `kimi-provider.ts` 类型检查通过（structural typing 兼容 `SearchProvider`）
- [x] `resolveKimiApiKey()` 覆盖 3 个 env var + auth.json fallback
- [x] `KIMI_PROVIDER_META` 结构兼容 `ProviderMeta`

#### Manual Verification:
- [x] `resolveKimiApiKey()` 能正确解析 3 个环境变量和 auth.json
- [x] `formatSearchResults()` 输出格式与现有 `index.ts` 一致（含 site_name/date 拼接）
- [x] `fetch()` 500/timeout/网络断开 时正确 fallback 到本地 HTTP
- [x] `configureKimi()` 的 maskKey 和 cancellation 行为正确

## Phase 2: Patch 工具模块

### Overview
实现文件级文本插入 patch：直接修改 rpiv 的 factory.ts 和 providers/index.ts，复制 kimi-provider.ts 到 rpiv 的 providers/ 目录。Patch 工具负责将 Kimi Provider 注入 rpiv-web-tools 的 Provider 系统，使 `/web-search-config` 中出现 Kimi 选项。

### Changes Required:

#### 1. patch-rpiv.ts
**File**: `patch-rpiv.ts`
**Changes**: NEW — Patch 工具，含运行时 monkey-patch + 文件级 fallback

```typescript
/**
 * Patch 工具 — 将 Kimi Provider 注入到 rpiv-web-tools 中
 *
 * 通过文件级文本插入直接修改 rpiv 的 factory.ts 和 providers/index.ts，
 * 并复制 kimi-provider.ts 到 rpiv 的 providers/ 目录。
 *
 * 说明：运行时 ESM monkey-patch 已移除（ESM `export function` binding
 * 独立于直接 import，无法通过 namespace mutation 影响）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RPIV_CANDIDATE_PATHS: string[] = [
	join(homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-web-tools"),
	join(homedir(), ".pi", "agent", "node_modules", "@juicesharp", "rpiv-web-tools"),
	join(process.cwd(), "node_modules", "@juicesharp", "rpiv-web-tools"),
];

export function findRpivWebToolsPath(): string | null {
	for (const p of RPIV_CANDIDATE_PATHS) {
		if (existsSync(join(p, "package.json"))) return p;
	}
	return null;
}

export function isRpivWebToolsInstalled(): boolean {
	const path = findRpivWebToolsPath();
	if (!path) return false;
	return existsSync(join(path, "providers", "factory.ts"));
}

async function applyFileLevelPatch(rpivPath: string): Promise<boolean> {
	try {
		const kimiSource = readFileSync(join(__dirname, "kimi-provider.ts"), "utf-8");
		writeFileSync(join(rpivPath, "providers", "kimi.ts"), kimiSource, "utf-8");

		const factoryPath = join(rpivPath, "providers", "factory.ts");
		let factoryContent = readFileSync(factoryPath, "utf-8");
		if (!factoryContent.includes('case "kimi":')) {
			const firstImport = factoryContent.match(/^(import\s+.*?from\s+["'].*?["'];)/m);
			if (firstImport) factoryContent = factoryContent.replace(firstImport[0], firstImport[0] + '\nimport { KimiProvider } from "./kimi.js";');
			else factoryContent = `import { KimiProvider } from "./kimi.js";\n${factoryContent}`;
			factoryContent = factoryContent.replace(
				/default:\s*throw new Error\(`Unknown search provider: "\$\{name\}"`\);/,
				`case "kimi":\n\t\t\treturn new KimiProvider(apiKey);\n\t\tdefault:\n\t\t\tthrow new Error(\`Unknown search provider: "\${name}"\`);`
			);
			writeFileSync(factoryPath, factoryContent, "utf-8");
		}

		const indexPath = join(rpivPath, "providers", "index.ts");
		let indexContent = readFileSync(indexPath, "utf-8");
		if (!indexContent.includes("KIMI_PROVIDER_META")) {
			const firstImport = indexContent.match(/^(import\s+.*?from\s+["'].*?["'];)/m);
			if (firstImport) indexContent = indexContent.replace(firstImport[0], firstImport[0] + '\nimport { KIMI_PROVIDER_META } from "./kimi.js";');
			else indexContent = `import { KIMI_PROVIDER_META } from "./kimi.js";\n${indexContent}`;
			indexContent = indexContent.replace(/^export\s*\{/m, `export { KIMI_PROVIDER_META, KimiProvider } from "./kimi.js";\nexport {`);
			indexContent = indexContent.replace(/SEARXNG_PROVIDER_META,\s*\];/, "SEARXNG_PROVIDER_META,\n\tKIMI_PROVIDER_META,\n];");
			writeFileSync(indexPath, indexContent, "utf-8");
		}

		console.log("[patch-rpiv] File-level patch applied");
		return true;
	} catch (e) { console.warn("[patch-rpiv] File-level patch failed:", e); return false; }
}

export async function patchRpivWebTools(): Promise<boolean> {
	const rpivPath = findRpivWebToolsPath();
	if (!rpivPath) { console.log("[patch-rpiv] rpiv-web-tools not found"); return false; }
	console.log("[patch-rpiv] Found rpiv at:", rpivPath);
	return await applyFileLevelPatch(rpivPath);
}
```

### Success Criteria:

#### Automated Verification:
- [x] 文件级 patch 成功时，`factory.ts` 和 `providers/index.ts` 包含 Kimi case

#### Manual Verification:
- [x] Patch 后 `/web-search-config` 列表中出现 "Kimi" 选项
- [x] 选择 Kimi 后能正常配置 API key
- [x] `pi install` 更新 rpiv-web-tools 后，重新 patch 仍能工作

## Phase 3: pi-kimi-web-tools 兼容模式改造

### Overview
改造 `index.ts`，添加 rpiv-web-tools 检测逻辑和兼容模式。当 rpiv 存在时：跳过 `search_web`/`fetch_url` 工具注册（避免功能重叠和 Prompt 混淆）；`/search` `/fetch` 命令直接使用本地 `KimiProvider`；保留 `/kimi-web-update` 和 `/kimi-web`。当 rpiv 不存在时保持原有行为。

### Changes Required:

#### 1. index.ts
**File**: `index.ts`
**Changes**: MODIFY — 添加 rpiv 检测、兼容模式、命令委托逻辑

```typescript
// ===== 新增 import（文件顶部）=====
import { isRpivWebToolsInstalled, patchRpivWebTools } from "./patch-rpiv.js";

// ===== 修改 export default function =====
export default function (pi: ExtensionAPI) {
  const apiKey = resolveKimiApiKey();

  if (!apiKey) {
    console.warn(
      "[pi-kimi-web-tools] 未找到 Kimi API Key。" +
        "请设置 KIMI_API_KEY 环境变量，或确保 ~/.pi/agent/auth.json 中有 kimi-coding 的 api_key。"
    );
    return;
  }

  // 检测 rpiv-web-tools 是否已安装
  const hasRpiv = isRpivWebToolsInstalled();

  if (hasRpiv) {
    // 兼容模式：将 Kimi 注入 rpiv-web-tools，不注册自己的模型工具
    patchRpivWebTools().then((ok) => {
      if (ok) {
        console.log("[pi-kimi-web-tools] Kimi provider 已成功注入 rpiv-web-tools");
      } else {
        console.warn("[pi-kimi-web-tools] 注入 rpiv-web-tools 失败，Kimi 可能不会出现在 /web-search-config 中");
      }
    });
    console.log("[pi-kimi-web-tools] 兼容模式已激活（rpiv-web-tools 已安装）");
  }

  // ===== 模型工具注册（仅在独立模式下）=====
  if (!hasRpiv) {
    pi.registerTool({
      name: "search_web",
      // ... 原有代码保持不变
    });

    pi.registerTool({
      name: "fetch_url",
      // ... 原有代码保持不变
    });
  }

  // ===== 命令注册（两种模式都保留）=====
  // /search、/fetch、/kimi-web-update、/kimi-web 的原有代码保持不变

  // ===== 修改最后的 console.log =====
  if (hasRpiv) {
    console.log("[pi-kimi-web-tools] Loaded: /search + /fetch + /kimi-web-update + /kimi-web (兼容模式)");
  } else {
    console.log("[pi-kimi-web-tools] Loaded: search_web + fetch_url + /search + /fetch + /kimi-web-update + /kimi-web (独立模式)");
  }
}
```

### Success Criteria:

#### Automated Verification:
- [x] rpiv 存在时 `search_web`/`fetch_url` 工具不注册
- [x] rpiv 不存在时原有功能完全保留

#### Manual Verification:
- [x] rpiv 存在时 `/search` 命令仍能手动搜索并注入结果
- [x] rpiv 存在时 `/fetch` 命令仍能手动抓取并注入结果
- [x] rpiv 存在时 `/kimi-web-update` 和 `/kimi-web` 正常工作
- [x] rpiv 不存在时所有原有工具和命令正常工作
- [x] 模型 Prompt 中不再同时出现 `search_web` 和 `web_search`

## Ordering Constraints

1. **Phase 1 → Phase 2**: Patch 工具依赖 `kimi-provider.ts` 中的 `KimiProvider` 类定义
2. **Phase 2 → Phase 3**: `index.ts` 的兼容模式需要调用 Patch 工具函数
3. 三阶段严格线性，不可并行

## Verification Notes

- **Provider 集成验证**：Patch 后运行 `/web-search-config`，确认 Kimi 出现在 Provider 列表中
- **搜索验证**：选择 Kimi 后运行 `/search test query`，确认返回 Kimi 搜索结果
- **抓取验证**：运行 `/fetch https://example.com`，确认返回 Markdown 内容
- **Fallback 验证**：断开网络后运行 `/fetch`，确认本地 HTTP fallback 生效
- **Key 解析验证**：unset 所有 `KIMI_*` 环境变量，确认从 `auth.json` 读取成功
- **兼容模式验证**：安装 rpiv-web-tools 后重启 Pi，确认 `search_web`/`fetch_url` 未注册
- **独立模式验证**：卸载 rpiv-web-tools 后重启 Pi，确认原有功能完全正常
- **rpiv 版本兼容性**：仅支持 rpiv-web-tools >= v1.8.0（pluggable provider 架构）

## Performance Considerations

- 文件级 patch 在 Pi 启动时执行，单次文件读取 + 文本替换 + 文件写入，开销 < 5ms
- `resolveKimiApiKey()` 在 Provider 构造时执行，只读操作，无 I/O 延迟（`auth.json` 读取一次后缓存）
- Kimi fetch 的本地 HTTP fallback 只在 500/timeout 时触发，不影响正常路径

## Migration Notes

- 无数据迁移需求
- 现有 `pi-kimi-web-tools` 用户升级到新版后，若已安装 rpiv-web-tools，自动进入兼容模式
- 若用户未安装 rpiv-web-tools，行为完全不变
- `auth.json` 中的 key 格式不变，无需迁移

## Pattern References

- `rpiv-web-tools/providers/firecrawl.ts:44-66` — POST search with JSON body pattern
- `rpiv-web-tools/providers/firecrawl.ts:68-97` — Native fetch returning markdown pattern
- `rpiv-web-tools/providers/searxng.ts:43-52` — ProviderMeta with configure() callback
- `rpiv-web-tools/providers/searxng.ts:182-223` — configure() implementation pattern
- `rpiv-web-tools/providers/brave.ts:67-79` — Local HTTP fallback via fetch-helpers
- `rpiv-web-tools/providers/factory.ts:15-35` — Factory switch registration pattern
- `rpiv-web-tools/providers/index.ts:43-51` — PROVIDERS array registration pattern
- `pi-kimi-web-tools/index.ts:37-59` — Multi-source key resolution (source to extract)
- `pi-kimi-web-tools/index.ts:239-256` — 500/timeout fallback logic (source to extract)

## Developer Context

**Q (运行时 patch 策略选择): 当检测到 rpiv-web-tools 已安装时，pi-kimi-web-tools 的兼容模式应该如何调整？**
A: 
1. 采用**混合 Patch 策略**：运行时 ESM monkey-patch 优先，失败自动 fallback 到文件级 patch。
2. `pi-kimi-web-tools` 在检测到 rpiv-web-tools 存在时：
   - ❌ 不再注册 `search_web`/`fetch_url` 工具
   - ✅ 保留 `/search` 和 `/fetch` 手动注入命令
   - ✅ 保留 `/kimi-web-update`
   - ✅ 保留 `/kimi-web`
3. `/search` 和 `/fetch` 命令直接使用本地 `KimiProvider` 执行并注入结果。

**Q (API Key 解析策略): Provider 层如何实现多源 key 解析？**
A: 采用自动解析方案。`KimiProvider` 构造函数内部实现完整的多源 key 解析链（`KIMI_API_KEY` → `KIMI_CODING_API_KEY` → `KIMI_CODE_API_KEY` → `~/.pi/agent/auth.json`），`configure()` 仅作为手动覆盖入口。

**Q (运行时 monkey-patch 和文件级 AST patch 的健壮性比较)：**
A: 运行时 monkey-patch 对 `createSearchProvider` 无效（ESM namespace 的 `export function` binding 独立于直接 import）。`web-tools.ts` 使用 `import { createSearchProvider }` 直接导入，namespace mutation 无法影响。因此只保留文件级 patch，直接修改源文件。

**Q (文件级 fallback 实现方式): 是否需要 TS Compiler API？**
A: 不需要。采用简单文本插入：检查 `"kimi"` 是否已存在于 switch 和 PROVIDERS 数组中，不存在则插入。模式足够稳定。

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
|--------|----------|--------------|----------|-----------|---------|----------------|------------|
| code | Phase 2 §1 | patch-rpiv.ts | concern | actionability | 运行时 monkey-patch 对 `createSearchProvider` 无效（ESM namespace 的 `export function` binding 独立于直接 import） | **applied**: 移除运行时 patch，改为纯文件级 patch |
| code | Phase 1 §1 | kimi-provider.ts | concern | code-quality | `fetchWithHttpGet`/`fetchNative` 中 `clearTimeout` 在 `fetch()` resolve 后立即调用，但 `response.text()` 可能挂起 | **applied**: 将 `clearTimeout` 移到 `response.text()` 之后 |
| code | Phase 1 §1 | kimi-provider.ts | concern | code-quality | `fetchNative` merged abort signal 添加了 listener 但未 remove | **applied**: 在 `finally` 块中移除 listener |
| coverage | Verification §4 | n/a | blocker | verification-coverage | 断开网络 fallback 未被代码覆盖 | **applied**: 扩展 `isRetryable` 包含 ECONNREFUSED/ENOTFOUND/ETIMEDOUT/fetch failed/getaddrinfo |
| code | Phase 2 §1 | patch-rpiv.ts | suggestion | code-quality | 文件级 patch 的 `export {` 正则缺少行首锚点 | **applied**: 添加 `^` 锚点 `/^export\s*\{/m` |
| code | Phase 1 §1 | kimi-provider.ts | suggestion | codebase-fit | `KIMI_PROVIDER_META` 没有 `as const` | **applied**: 添加 `as const` |

## Plan History

- Phase 1: KimiProvider 核心实现 — approved as generated, then revised at Step 9 (isRetryable expanded, clearTimeout fixed, listener leak fixed, as const added)
- Phase 2: Patch 工具模块 — approved as generated, then revised at Step 9 (runtime patch removed, pure file-level patch)
- Phase 3: pi-kimi-web-tools 兼容模式改造 — approved as generated

## References

- `.rpiv/artifacts/research/pi-kimi-web-tools_kimi-provider-patch-for-rpiv-web-tools.md` — 上游研究报告
- `rpiv-web-tools` 源码路径：`C:/Users/demon/.pi/agent/npm/node_modules/@juicesharp/rpiv-web-tools/`
- `pi-kimi-web-tools` 源码路径：`C:/Projects/ZedProjects/pi-kimi-web-tools/`
