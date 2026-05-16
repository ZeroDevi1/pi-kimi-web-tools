# pi-kimi-web-tools

将 Kimi CLI 官方的 SearchWeb / FetchURL 工具桥接到 Pi Coding Agent。

## 原理

Kimi CLI 是开源项目（https://github.com/MoonshotAI/kimi-cli），其内置的 `SearchWeb` 和 `FetchURL` 工具通过独立的 HTTP API 端点实现：

- **Search**: `POST https://api.kimi.com/coding/v1/search`
- **Fetch**: `POST https://api.kimi.com/coding/v1/fetch`

本扩展通过逆向 Kimi CLI 源码获取了完整的 API Schema，直接在 Pi 中注册为模型可见的 native tools。

## 功能

| 工具 | 功能 | 参数 |
|------|------|------|
| `SearchWeb` | 网页搜索 | `query`, `limit` (1-20), `include_content` (bool) |
| `FetchURL` | 网页抓取 | `url` |

## 优势

- **官方服务**：使用 Kimi 自有的搜索/抓取后端，与 Kimi 模型对齐更好
- **统一账单**：搜索/抓取费用计入 Kimi Coding Plan，无需额外购买 Exa/Perplexity
- **中文优化**：中文搜索质量通常优于国外搜索服务
- **零配置**：自动复用已有的 `kimi-coding` API Key

## 安装

```bash
pi install git:github.com/ZeroDevi1/pi-kimi-web-tools
/reload
```

或在 `settings.json` 的 `packages` 中添加：
```json
"git:github.com/ZeroDevi1/pi-kimi-web-tools"
```

## 更新

扩展发布后，在 Pi 中执行：

```bash
/kimi-web-update   # 从 GitHub 拉取最新代码
/reload            # 重新加载扩展
```

无需手动 `git pull` 或重新 `pi install`。

## API Key 读取优先级

1. `KIMI_API_KEY` / `KIMI_CODING_API_KEY` / `KIMI_CODE_API_KEY` 环境变量
2. `~/.pi/agent/auth.json` 中 `kimi-coding` 的 `api_key`
3. `~/.pi/agent/auth.json` 中 `kimi-coder` 的 `api_key`

## 命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `/search <query>` | `/search Rust async runtime` | 手动触发网页搜索，结果直接注入对话 |
| `/fetch <url>` | `/fetch https://www.rust-lang.org` | 手动触发网页抓取，内容直接注入对话 |
| `/kimi-web-update` | `/kimi-web-update` | 从 GitHub 拉取最新代码，然后 `/reload` 生效 |
| `/kimi-web` | `/kimi-web` | 查看扩展状态（API Key 掩码、已注册工具/命令） |

### `/search` vs `SearchWeb` 工具的区别

- **`SearchWeb`（工具）**：模型自主判断何时搜索，用户无感知
- **`/search`（命令）**：用户手动触发，结果直接显示，适合主动调研

两者共用同一个 Kimi 搜索后端，结果格式相同。

## 与现有扩展的关系

| 现有扩展 | 本扩展替代？ | 说明 |
|----------|-------------|------|
| `pi-web-access` | **部分替代** | Kimi search/fetch 替代基础搜索/抓取，但 `pi-web-access` 的视频理解、GitHub 克隆、PDF 提取、curator 审阅仍不可替代 |
| `@apmantza/greedysearch-pi` | **可以替代** | 如果 Kimi 搜索满足需求，可以去掉 greedysearch |
| `pi-smart-fetch` | **可以替代** | Kimi fetch 已有反爬和内容提取，但 smart-fetch 的 TLS 模拟可能更强 |

## 已知限制

- `SearchWeb` 的 `include_content=true` 会消耗大量 token，limit 较大时避免开启
- 搜索结果质量依赖 Kimi 搜索后端，可能与 Perplexity/Exa 有差异
- Kimi fetch 服务对某些域名（如 `github.com`、`platform.moonshot.cn`）返回 500，此时会自动 fallback 到本地 HTTP 抓取
- 不支持视频理解、GitHub 仓库克隆、PDF 提取（这些需保留 `pi-web-access`）
