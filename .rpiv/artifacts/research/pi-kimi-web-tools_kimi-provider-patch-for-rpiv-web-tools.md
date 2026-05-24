---
date: "2026-05-24T00:27:02.759Z"
author: ZeroDevi1
commit: 7fa61dd
branch: main
repository: pi-kimi-web-tools
topic: "将 Kimi 搜索能力合并到 rpiv-web-tools 的 Patch 工具方案"
tags: [research, codebase, rpiv-web-tools, pi-kimi-web-tools, provider, patch, monkey-patch, ESM]
status: complete
last_updated: "2026-05-24T00:27:02.759Z"
last_updated_by: ZeroDevi1
---

# Research: 将 Kimi 搜索能力合并到 rpiv-web-tools 的 Patch 工具方案

## Research Question
如何在不 Fork rpiv-web-tools 的前提下，通过一个可重复应用的 Patch 工具，将 pi-kimi-web-tools 的 Kimi 搜索能力注入到 @juicesharp/rpiv-web-tools 的 Provider 系统中？同时让 pi-kimi-web-tools 在 rpiv-web-tools 存在时退化为仅提供手动注入命令（`/search`、`/fetch`），避免工具名称冲突和 Prompt 混淆。

## Summary
`@juicesharp/rpiv-web-tools` v1.12.0 采用了一个完全封闭的 Provider 插件系统：通过 `factory.ts` 中的硬编码 `switch` 语句和 `providers/index.ts` 中的静态 `PROVIDERS` 数组来管理所有搜索 Provider（Brave、Tavily、Serper、Exa、Jina、Firecrawl、SearXNG）。该系统没有运行时插件 API。

要将 Kimi 注入该系统，有两种互补策略：
1. **运行时 ESM Monkey-patch**：利用 ESM live binding，在 Pi 启动后、`/web-search-config` 首次执行前，将 `KIMI_PROVIDER_META` 推入 `PROVIDERS` 数组，并包装 `createSearchProvider`。不修改任何文件，Survive `pi install`。
2. **文件级 AST Patch**：使用 TypeScript Compiler API 对 `factory.ts` 和 `providers/index.ts` 做语义级插入（新增 switch case、PROVIDERS 数组元素、import、re-export），同时新建 `providers/kimi.ts`。更 robust，但 `node_modules` 更新后需重新 patch。

开发者决策采用**混合策略**：运行时注入优先，失败自动 fallback 到文件级 patch。同时，`pi-kimi-web-tools` 在检测到 rpiv-web-tools 已安装时，不再注册 `search_web`/`fetch_url` 模型工具和对应 Prompt 提示词，仅保留 `/search` 和 `/fetch` 手动注入命令（rpiv-web-tools 没有这两个命令）。

## Detailed Findings

### rpiv-web-tools 的 Provider 系统架构

rpiv-web-tools 的 Provider 系统由四个核心文件构成：

#### 1. `providers/types.ts` — Provider 接口契约
- `SearchProvider` 接口（`types.ts:19-27`）要求实现 `name`、`label`、`envVar`、`search()`、`fetch()`。
- `SearchResult`（`types.ts:1-5`）仅含 `title`、`url`、`snippet`。
- `FetchResponse`（`types.ts:12-16`）要求 `{ text, title?, contentType?, contentLength? }`。
- `ProviderMeta`（`types.ts:72`）含 `name`、`label`、`envVar?`、`baseUrlEnvVar?`、`defaultBaseUrl?`、`configure?`。

#### 2. `providers/factory.ts` — Provider 实例化工厂
- `createSearchProvider(name, creds)`（`factory.ts:15`）是一个硬编码 `switch`，列举所有 Provider 的 `case`。
- 每个 `case` 返回对应 Provider 类的实例，传入 `apiKey`（SearXNG 额外传入 `baseUrl`）。
- **新增 Provider 必须在 switch 中新增 case**（`factory.ts:17-32`）。

#### 3. `providers/index.ts` — Provider 元数据注册表
- `PROVIDERS: readonly ProviderMeta[]`（`providers/index.ts:43-51`）是静态数组，驱动 `/web-search-config` UI、Key 解析、Provider 排序。
- 每个 Provider 导出 `PROVIDER_META` 常量，并在 `PROVIDERS` 数组中注册。
- **新增 Provider 必须 push 到该数组**（`providers/index.ts:43`）。
- 同时需要在 re-export 块中导出新的符号（`providers/index.ts:10-27`）。

#### 4. `web-tools.ts` — Orchestrator（完全 Generic）
- `instantiateActiveProvider(config)`（`web-tools.ts:151`）读取 `config.provider`，通过 `PROVIDERS.find()` 找 meta，再调用 `createSearchProvider()` 实例化。
- `registerWebSearchConfigCommand()`（`web-tools.ts:462-622`）遍历 `PROVIDERS` 构建选择 UI、key 解析、配置持久化。
- **关键发现**：Orchestrator 从不硬编码 Provider 名称。只要 `PROVIDERS` 数组和 `createSearchProvider` 包含 Kimi，`/web-search-config` UI、Key 解析、配置保存全部自动生效。

### Kimi 的 Search/Fetch API 与 rpiv 接口的适配

#### Search 字段映射
Kimi 搜索 API（`pi-kimi-web-tools/index.ts:82-113`）返回 `search_results`，每项含 `site_name`、`title`、`url`、`snippet`、`content`、`date`、`icon`、`mime`。但 `SearchResult` 仅接受 `title`、`url`、`snippet`。

- `title` ← `item.title`
- `url` ← `item.url`
- `snippet` ← `item.snippet`（当 `includeContent=false`）；当启用内容抓取时，`item.content` 包含完整内容，可合并到 `snippet` 中或单独处理
- `site_name`、`date` 可拼接进 `snippet` 以保留信息（如 `"[site_name] snippet"`）
- `icon`、`mime` 必须丢弃（接口不支持）

#### Fetch 响应映射
Kimi fetch API（`pi-kimi-web-tools/index.ts:213-256`）通过 `Accept: text/markdown` 获取已提取的 Markdown 内容，返回纯字符串。

- `text` ← Markdown 字符串
- `title` ← 可尝试从 Markdown 中解析第一个 `# ` 标题，或留 `undefined`
- `contentType` ← `"text/markdown"`
- `contentLength` ← `text.length`

**Pipeline 选择**：Kimi fetch 返回已提取的 Markdown，不应经过 `fetch-helpers.ts` 的 HTML→text 管道（该管道是为原始 HTML 设计的）。应直接调用 Kimi `/fetch` 端点，与 Tavily/Jina/Firecrawl 的"native extraction"模式一致。

#### 本地 HTTP Fallback
`pi-kimi-web-tools/index.ts:239-256` 在 Kimi fetch 返回 500 或超时时，fallback 到本地 `fetchWithHttpGet`（`index.ts:173-210`），做 HTML 剥离和文本提取。

- rpiv-web-tools 的 Orchestrator 中没有 Provider-level fallback 机制。
- **建议**：将 fallback 逻辑保留在 `KimiProvider.fetch()` 内部，与 Brave/Tavily 等其他 Provider 的"自包含"哲学一致。Orchestrator 只负责调用 `provider.fetch()` 并统一处理截断/溢出。
- `fetchWithHttpGet` 的 HTML 提取逻辑可复用 `fetch-helpers.ts` 中的 `htmlToText()` / `extractBodyAsText()`，避免代码重复。

### API Key 多源解析映射

`pi-kimi-web-tools/index.ts:37-59` 的 `resolveKimiApiKey()` 按以下顺序解析：
1. `KIMI_API_KEY`
2. `KIMI_CODING_API_KEY`
3. `KIMI_CODE_API_KEY`
4. `~/.pi/agent/auth.json` → `kimi-coding.key`
5. `~/.pi/agent/auth.json` → `kimi-coder.key`

rpiv-web-tools 的 `resolveProviderApiKey()`（`web-tools.ts:130-145`）只支持单 `envVar` + `config.apiKeys[providerName]`。

**解决方案**：采用 SearXNG 模式（`searxng.ts:182`），为 Kimi 的 `ProviderMeta` 提供 `configure()` 回调。在回调中实现完整的多源 key 解析链，将解析结果存入 provider 实例。Orchestrator 的通用 key 解析可作为兜底。

```ts
// 建议的 Kimi ProviderMeta
export const KIMI_PROVIDER_META: ProviderMeta = {
  name: "kimi",
  label: "Kimi",
  envVar: "KIMI_API_KEY", // 兜底：Orchestrator 也会检查这个
  configure: async (ui, current) => {
    // 自定义配置逻辑：尝试多源解析，或提示用户输入
    // 返回 { apiKey }
  },
};
```

### pi-kimi-web-tools 的"兼容模式"行为

当前 `pi-kimi-web-tools` 注册了 2 个工具和 4 个命令：
- 工具：`search_web`、`fetch_url`
- 命令：`/search`、`/fetch`、`/kimi-web-update`、`/kimi-web`

与 `rpiv-web-tools` 的冲突：
- 工具名冲突：`search_web` vs `web_search`，`fetch_url` vs `web_fetch`（不同名，但功能重叠，会增加 Prompt 上下文体积和模型选择困惑）
- 命令缺失：rpiv-web-tools 只有 `/web-search-config`，没有 `/search` `/fetch`

**开发者决策**：当检测到 rpiv-web-tools 已安装时：
- ✅ 保留 `/search` 和 `/fetch`（rpiv 没有，且手动注入 UX 有价值）
- ❌ 不再注册 `search_web`/`fetch_url` 工具
- ❌ 不再注入对应工具的 Prompt 提示词
- ❌ 删除 `/kimi-web-update`（改用 `pi install` 正常更新）
- ❌ 删除 `/kimi-web`（状态查看可用 `/web-search-config --show` 替代）

**检测逻辑**：`pi-kimi-web-tools` 的默认导出函数（`index.ts:261`）在初始化时检查 `node_modules` 中是否存在 `@juicesharp/rpiv-web-tools`，或检查 Pi 的 ExtensionAPI 中是否已注册 `web_search`/`web_fetch` 工具。

### Patch 策略：运行时 Monkey-patch vs 文件级 AST Patch

#### 策略 A：运行时 ESM Monkey-patch（优先）

原理：利用 ESM live binding，在 Pi 加载 rpiv-web-tools 后、首次工具调用前，修改模块的导出对象。

```ts
import { PROVIDERS } from "@juicesharp/rpiv-web-tools/providers/index.js";
import * as factory from "@juicesharp/rpiv-web-tools/providers/factory.js";

// 1. 将 Kimi Meta 推入 PROVIDERS 数组
PROVIDERS.push(KIMI_PROVIDER_META);

// 2. 包装 createSearchProvider
const original = factory.createSearchProvider;
factory.createSearchProvider = (name, creds) => {
  if (name === "kimi") return new KimiProvider(creds.apiKey ?? "");
  return original(name, creds);
};
```

**优点**：
- 不修改 `node_modules` 中任何文件
- Survive `pi install` / `npm update`（每次 Pi 重启都会重新执行 patch）
- 无文件级冲突风险

**缺点**：
- 若上游将 `export function createSearchProvider` 改为 `export const createSearchProvider = ...`，ESM binding 变为 immutable，wrapper 失效
- 若上游 `Object.freeze(PROVIDERS)`，push 失败
- 若 Provider 文件重命名或路径变化，import 路径失效
- 需要 patch 作为独立的 Pi 扩展加载，且加载时机必须在 rpiv-web-tools 之后

#### 策略 B：文件级 AST Patch（Fallback）

原理：使用 TypeScript Compiler API 对 `factory.ts` 和 `providers/index.ts` 做语义级修改，同时新建 `providers/kimi.ts`。

修改点：
1. `factory.ts`：插入 `import { KimiProvider } from "./kimi.js"`；在 switch 中插入 `case "kimi": return new KimiProvider(apiKey);`
2. `providers/index.ts`：插入 `import { KIMI_PROVIDER_META } from "./kimi.js"`；在 `PROVIDERS` 数组中插入 `KIMI_PROVIDER_META`；在 re-export 块中添加 `export { KIMI_PROVIDER_META, KimiProvider } from "./kimi.js"`
3. 新建 `providers/kimi.ts`：实现 `KimiProvider` 类

**优点**：
- 不受 ESM binding 风格变化影响
- 语义级插入，对注释和空格变化免疫
- 可以校验修改后的文件语法正确性

**缺点**：
- `pi install` / `npm update` 会覆盖修改，需要重新 patch
- 需要 checksum 机制检测文件是否被覆盖
- 实现复杂度更高（需要 TS compiler API）

#### 混合策略（最终决策）

1. Patch 工具作为一个独立的 Pi 扩展（或 npm 包）安装
2. 启动时先尝试**运行时 monkey-patch**：
   - 尝试 import rpiv-web-tools 的 provider 模块
   - 验证 `PROVIDERS` 是否可 push、`createSearchProvider` 是否可 wrap
   - 若成功，记录日志并结束
3. 若运行时 patch 失败（如 binding immutable），自动 fallback 到**文件级 AST patch**：
   - 读取 `factory.ts` 和 `providers/index.ts`
   - 验证原始文件 checksum（确保基于已知版本）
   - 使用 TS compiler API 做 AST 插入
   - 写回文件，验证语法
   - 记录已 patch 的版本
4. 提供 `pi install` hook 或手动命令 `/kimi-patch` 供用户在更新后重新应用 patch

### pi-kimi-web-tools 的 SDK 版本兼容性

- `pi-kimi-web-tools` 导入 `ExtensionAPI` from `@mariozechner/pi-coding-agent`
- `rpiv-web-tools` 导入 `ExtensionAPI` from `@earendil-works/pi-coding-agent`
- **但 Provider 层完全不依赖 Pi SDK**：`providers/types.ts`、`providers/brave.ts`、`providers/tavily.ts` 都不 import 任何 Pi 包
- 因此 `kimi.ts` 可以纯用全局 `fetch` + Node.js `fs` 实现，无需桥接两个 `ExtensionAPI` 类型
- 唯一需要 Pi SDK 的地方是扩展入口（`index.ts`）和命令注册（`web-tools.ts` 中的 `/web-search-config`），这些由 rpiv-web-tools 自身处理

### `/search` 和 `/fetch` 命令在 rpiv-web-tools 中的实现

`pi-kimi-web-tools/index.ts:376-402` 的 `/search` 和 `pi-kimi-web-tools/index.ts:403-425` 的 `/fetch` 使用 `pi.sendUserMessage(text, { deliverAs: "followUp" })` 将结果作为合成用户消息注入对话。

rpiv-web-tools 目前没有这种手动注入命令。要在合并后保留这个功能，有两种方案：

**方案 A（推荐）**：在 `pi-kimi-web-tools` 中保留这两个命令，但让它们委托给 rpiv-web-tools 的 `web_search`/`web_fetch` 工具执行，结果用 `sendUserMessage` 注入。这样 pi-kimi-web-tools 退化为一个"命令包装器"，真正的搜索能力由 rpiv-web-tools 提供。

**方案 B**：将 `/search` 和 `/fetch` 命令直接 patch 进 rpiv-web-tools 的 `web-tools.ts`。但这需要修改 rpiv 的 orchestrator，blast radius 更大。

开发者偏好方案 A（在 pi-kimi-web-tools 中保留命令，委托给 rpiv 工具）。

## Code References

- `rpiv-web-tools/providers/types.ts:1-5` — `SearchResult` 接口定义（仅 title/url/snippet）
- `rpiv-web-tools/providers/types.ts:12-16` — `FetchResponse` 接口定义
- `rpiv-web-tools/providers/types.ts:19-27` — `SearchProvider` 接口定义
- `rpiv-web-tools/providers/types.ts:72` — `ProviderMeta` 接口定义
- `rpiv-web-tools/providers/factory.ts:15-35` — `createSearchProvider` 硬编码 switch
- `rpiv-web-tools/providers/index.ts:43-51` — `PROVIDERS` 静态数组
- `rpiv-web-tools/providers/index.ts:10-27` — re-export 块
- `rpiv-web-tools/providers/brave.ts:52-66` — Brave fetch 实现（使用 fetch-helpers）
- `rpiv-web-tools/providers/tavily.ts:42-96` — Tavily fetch 实现（native extraction）
- `rpiv-web-tools/providers/searxng.ts:34` — SearXNG ProviderMeta（含 baseUrlEnvVar、configure）
- `rpiv-web-tools/providers/searxng.ts:182` — SearXNG configure() 回调实现
- `rpiv-web-tools/web-tools.ts:130-145` — `resolveProviderApiKey` 单源 key 解析
- `rpiv-web-tools/web-tools.ts:151` — `instantiateActiveProvider` 运行时 Provider 实例化
- `rpiv-web-tools/web-tools.ts:234` — `registerWebSearchTool` 工具注册
- `rpiv-web-tools/web-tools.ts:330` — `registerWebFetchTool` 工具注册
- `rpiv-web-tools/web-tools.ts:462-622` — `registerWebSearchConfigCommand` 配置命令（完全 Generic）
- `rpiv-web-tools/package.json:39-45` — `files` 数组（控制 npm 发布内容）
- `rpiv-web-tools/package.json:50-52` — `pi.extensions` 加载入口
- `pi-kimi-web-tools/index.ts:15` — 导入 `@mariozechner/pi-coding-agent`
- `pi-kimi-web-tools/index.ts:37-59` — `resolveKimiApiKey` 多源 key 解析
- `pi-kimi-web-tools/index.ts:62-71` — Kimi `SearchResult` 本地类型定义（8 字段）
- `pi-kimi-web-tools/index.ts:82-113` — `callKimiSearch` Kimi 搜索 API 调用
- `pi-kimi-web-tools/index.ts:116-138` — `formatSearchResults` 结果格式化
- `pi-kimi-web-tools/index.ts:173-210` — `fetchWithHttpGet` 本地 HTTP fallback
- `pi-kimi-web-tools/index.ts:213-256` — `callKimiFetch` Kimi 抓取 API 调用
- `pi-kimi-web-tools/index.ts:261` — 扩展默认导出函数入口
- `pi-kimi-web-tools/index.ts:273` — `search_web` 工具注册
- `pi-kimi-web-tools/index.ts:338` — `fetch_url` 工具注册
- `pi-kimi-web-tools/index.ts:376-402` — `/search` 命令注册与实现
- `pi-kimi-web-tools/index.ts:403-425` — `/fetch` 命令注册与实现
- `pi-kimi-web-tools/index.ts:431` — `/kimi-web-update` 命令注册
- `pi-kimi-web-tools/index.ts:451` — `/kimi-web` 命令注册
- `pi-kimi-web-tools/package.json:18-20` — `pi.extensions` 加载配置

## Integration Points

### Inbound References
- `pi-kimi-web-tools/index.ts:261` — 被 Pi 加载器调用（`pi.extensions` 入口）
- `rpiv-web-tools/index.ts:11-13` — 被 Pi 加载器调用（`pi.extensions` 入口）

### Outbound Dependencies
- `rpiv-web-tools` 依赖 `@juicesharp/rpiv-config`（config 持久化）
- `rpiv-web-tools` 依赖 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui`
- `pi-kimi-web-tools` 依赖 `@mariozechner/pi-coding-agent`
- Kimi API 端点：`https://api.kimi.com/coding/v1/search`、`https://api.kimi.com/coding/v1/fetch`

### Infrastructure Wiring
- `rpiv-web-tools/web-tools.ts:151` — `instantiateActiveProvider` 桥接 factory + PROVIDERS 数组
- `rpiv-web-tools/web-tools.ts:462` — `/web-search-config` 命令的 Provider 选择 UI
- `pi-kimi-web-tools/index.ts:261` — 扩展入口，决定注册哪些工具和命令

## Architecture Insights

1. **Orchestrator 的 Generic 设计是 Patch 可行性的关键**：`web-tools.ts` 从不硬编码 Provider 名称，所有 Provider 枚举都通过 `PROVIDERS.find()` 和 `PROVIDERS.filter()` 完成。这意味着只要数组中有 Kimi，UI、Key 解析、配置保存全部自动生效，无需修改 Orchestrator 代码。

2. **Provider 文件是自包含的**：每个 Provider 只 import `./types.js` 和可选的 `./fetch-helpers.js`，不依赖 `web-tools.ts` 或任何 Pi SDK。这保证了 `kimi.ts` 可以纯用全局 `fetch` 实现，且不会产生循环依赖。

3. **ESM live binding 使运行时 patch 成为可能**：`export const PROVIDERS = [...]` 的 binding 不可变，但数组对象本身是可变的，`.push()` 可以成功。`export function createSearchProvider` 的 binding 是可变的，可以被 wrapper 替换。这是运行时 patch 的技术基础。

4. **SearXNG 是最复杂的 Provider 模板**：它引入了 `baseUrlEnvVar`、`defaultBaseUrl`、`configure()` 回调、自定义 creds 对象。Kimi 的多源 key 解析可以复用 `configure()` 模式，但不需要 baseUrl。

5. **rpiv-web-tools 直接发布 TypeScript 源码**：`package.json:39-45` 的 `files` 数组包含 `.ts` 文件，`pi.extensions` 指向 `./index.ts`。Pi 直接运行 TypeScript（或内部有 TS 编译器）。这使得 AST patch 可以直接操作源文件，无需处理编译产物。

## Precedents & Lessons

3 个类似的 Provider 添加被分析。

### Precedent: v1.8.0 从单体到 Pluggable Provider 架构重构
**Commit(s)**: `da06f9e070c22d5bbd8ff80f1b62c8cb48ae8426` — published as v1.8.0 (2026-05-16)
**Blast radius**: 10 个新文件，原 `web-tools.ts` 完全重写
  - `providers/` 目录新建：types.ts、factory.ts、index.ts、fetch-helpers.ts、brave.ts、tavily.ts、serper.ts、exa.ts、jina.ts、firecrawl.ts
  - `web-tools.ts` 从 Brave-only 改为 generic orchestrator
  - `index.ts` 重新导出 `createSearchProvider` 和类型

**Follow-up fixes**:
- `441cf45e92660a4f6c10b03350dc1291dd7580e7` — v1.8.1（次日发布）— 将 config I/O 提取到 `@juicesharp/rpiv-config`；修复 `saveConfig()` 的 boolean 返回值和磁盘写入失败保护

**教训**：大规模重构后立即出现 config 持久化 bug。任何修改配置写入路径的改动都必须验证写入是否成功。

### Precedent: v1.12.0 添加 SearXNG Provider
**Commit(s)**: `c1df0a5ccf4422785c3d73ec92aabaaf29e4a9be` — published as v1.12.0 (2026-05-21)
**Blast radius**: 5 文件改动，引入首个自托管 Provider 和自定义配置 UI
  - `providers/searxng.ts` — 新建（8900 bytes，最大的 Provider 文件）
  - `providers/types.ts` — 扩展 `ProviderMeta`（新增 `baseUrlEnvVar`、`defaultBaseUrl`、`configure`）
  - `providers/factory.ts` — 添加 SearXNG import 和 case；将签名从 `(name, apiKey: string)` 改为 `(name, creds: ProviderCredentials)`
  - `providers/index.ts` — 添加 `SEARXNG_PROVIDER_META` 到 `PROVIDERS` 数组
  - `web-tools.ts` — 添加 `baseUrls` 到 config schema；添加 `resolveProviderBaseUrl()`；添加 `configure()` 通用分发

**Pattern of modification**：
1. 新建 provider 文件（class + PROVIDER_META + 可选 configure）
2. factory.ts 添加 import + case（若需非 apiKey 参数则改签名）
3. index.ts 添加 import + PROVIDERS 数组元素 + re-export
4. types.ts 若引入新概念则扩展接口
5. web-tools.ts 若需新 config 字段则扩展 schema 和解析

**教训**：SearXNG 是添加新 Provider 的最复杂案例。Kimi 只需要 API key（不需要 baseUrl），因此应该是 3 文件改动（provider 文件、factory、index），不需要改 types.ts 或 web-tools.ts。

### Composite Lessons

- `PROVIDERS` 数组是事实源 — 驱动 UI、Key 解析、Provider 排序。忘记 push 会导致 Provider 对用户不可见
- Factory 签名变更具有传染性 — SearXNG 迫使 `createSearchProvider` 从 `(name, apiKey)` 改为 `(name, creds)`。Kimi 若只需 apiKey 则不需要改签名
- 自定义配置 UI 需要 `ProviderMeta.configure` 回调 — SearXNG 是唯一使用此功能的 Provider。Kimi 的多源 key 解析可以复用这个模式
- Config 持久化错误是重构后的 #1 bug — v1.8.1 立即修复了 saveConfig 失败处理
- `fetch()` 行为分两类 — Brave/Serper/SearXNG 用 raw HTTP + HTML-to-text；Tavily/Exa/Jina/Firecrawl 用 native extraction。Kimi 属于后者（Markdown 提取）
- Provider 文件是自包含的 — 只 import `./types.js` 和可选的 `./fetch-helpers.js`，不依赖 web-tools.ts

## Historical Context (from `.rpiv/artifacts/`)

无历史研究文档（首次在此仓库使用 research skill）。

## Developer Context

**Q (运行时 patch 策略选择): 当检测到 rpiv-web-tools 已安装时，pi-kimi-web-tools 的兼容模式应该如何调整？**
A: 
1. 采用**混合 Patch 策略**：运行时 ESM monkey-patch 优先，失败自动 fallback 到文件级 AST patch。
2. `pi-kimi-web-tools` 在检测到 rpiv-web-tools 存在时：
   - ❌ 不再注册 `search_web`/`fetch_url` 工具（避免与 `web_search`/`web_fetch` 功能重叠和 Prompt 混淆）
   - ✅ 保留 `/search` 和 `/fetch` 手动注入命令（rpiv-web-tools 没有这两个命令，且手动搜索 UX 有价值）
   - ❌ 删除 `/kimi-web-update`（正常 `pi install` 更新即可）
   - ❌ 删除 `/kimi-web`（状态查看用 `/web-search-config --show` 替代）
3. `/search` 和 `/fetch` 命令改为委托给 rpiv-web-tools 的 `web_search`/`web_fetch` 工具执行，结果用 `sendUserMessage(..., { deliverAs: "followUp" })` 注入对话。

**Q (rpiv-web-tools 的 provider 层是否可以在不引入 Pi SDK 的情况下实现 Kimi 支持)：**
A: 可以。Provider 文件（如 `brave.ts`、`tavily.ts`）不依赖任何 Pi SDK，只用全局 `fetch` 和 Node.js `fs`。`kimi.ts` 同理。

**Q (运行时 monkey-patch 和文件级 AST patch 的健壮性比较)：**
A: 运行时 patch 更 survive `node_modules` 更新但受上游绑定风格变化影响；文件级 patch 更 robust 但会被 `pi install` 覆盖。混合策略（运行时优先 + fallback）是最佳方案。

## Related Research

无相关研究文档（首次研究）。

## Open Questions

1. **运行时 Patch 的加载顺序**：混合 patch 工具需要作为 Pi 扩展加载，且必须在 rpiv-web-tools 之后加载。如何确保加载顺序？是否需要 Pi 的扩展依赖声明机制？
2. **checksum 管理**：文件级 patch 需要维护各版本 rpiv-web-tools 的原始文件 checksum。patch 工具如何自动获取/更新这些 checksum？
3. **Kimi Provider 的 `configure()` 回调实现细节**：多源 key 解析（env var → auth.json fallback）在 `configure()` 中的具体实现方式，以及与 Orchestrator 的 `resolveProviderApiKey()` 的交互边界。
4. **Fallback HTTP 提取的复用**：`fetchWithHttpGet` 的 HTML 剥离逻辑是否可以完全复用 `fetch-helpers.ts` 中的 `htmlToText()` / `extractBodyAsText()`？还是需要保留 pi-kimi-web-tools 中自定义的轻量提取逻辑？
5. **Patch 工具的分发方式**：patch 工具本身应该作为 Pi 扩展（npm 包）分发，还是作为 pi-kimi-web-tools 仓库中的一个子模块/脚本？
