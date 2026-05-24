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

/** rpiv-web-tools 的可能安装路径 */
const RPIV_CANDIDATE_PATHS: string[] = [
	join(
		homedir(),
		".pi",
		"agent",
		"npm",
		"node_modules",
		"@juicesharp",
		"rpiv-web-tools",
	),
	join(
		homedir(),
		".pi",
		"agent",
		"node_modules",
		"@juicesharp",
		"rpiv-web-tools",
	),
	join(process.cwd(), "node_modules", "@juicesharp", "rpiv-web-tools"),
];

/**
 * 查找 rpiv-web-tools 的安装路径
 * @returns 安装路径，或 null（未安装）
 */
export function findRpivWebToolsPath(): string | null {
	for (const p of RPIV_CANDIDATE_PATHS) {
		if (existsSync(join(p, "package.json"))) {
			return p;
		}
	}
	return null;
}

/**
 * 检查 rpiv-web-tools 是否已安装且版本 >= v1.8.0（pluggable provider 架构）
 */
export function isRpivWebToolsInstalled(): boolean {
	const path = findRpivWebToolsPath();
	if (!path) return false;
	// 检查 providers/factory.ts 是否存在（v1.8.0+ 的标志）
	return existsSync(join(path, "providers", "factory.ts"));
}

// ---------------------------------------------------------------------------
// 文件级 Patch
// ---------------------------------------------------------------------------

/**
 * 执行文件级文本插入 patch
 *
 * 直接修改 rpiv 的源文件：
 * 1. 将本地 kimi-provider.ts 复制到 rpiv/providers/kimi.ts
 * 2. 在 factory.ts 中添加 import + switch case
 * 3. 在 providers/index.ts 中添加 import + PROVIDERS 数组元素 + re-export
 *
 * @param rpivPath rpiv-web-tools 安装路径
 * @returns 是否成功
 */
async function applyFileLevelPatch(rpivPath: string): Promise<boolean> {
	try {
		// 1. 复制 kimi-provider.ts 到 rpiv/providers/kimi.ts
		const kimiSourcePath = join(__dirname, "kimi-provider.ts");
		const kimiTargetPath = join(rpivPath, "providers", "kimi.ts");

		if (!existsSync(kimiSourcePath)) {
			console.warn(
				"[patch-rpiv] kimi-provider.ts not found at:",
				kimiSourcePath,
			);
			return false;
		}

		const kimiSource = readFileSync(kimiSourcePath, "utf-8");
		writeFileSync(kimiTargetPath, kimiSource, "utf-8");
		console.log("[patch-rpiv] Copied kimi-provider.ts to", kimiTargetPath);

		// 2. 修改 factory.ts
		const factoryPath = join(rpivPath, "providers", "factory.ts");
		if (!existsSync(factoryPath)) {
			console.warn("[patch-rpiv] factory.ts not found at:", factoryPath);
			return false;
		}

		let factoryContent = readFileSync(factoryPath, "utf-8");

		// 已 patch 检测
		if (factoryContent.includes('case "kimi":')) {
			console.log(
				"[patch-rpiv] factory.ts already contains 'kimi' case, skipping",
			);
		} else {
			// 添加 import（在第一个 import 之后插入）
			const firstImport = factoryContent.match(
				/^(import\s+.*?from\s+["'].*?["'];)/m,
			);
			if (firstImport) {
				factoryContent = factoryContent.replace(
					firstImport[0],
					firstImport[0] + '\nimport { KimiProvider } from "./kimi.js";',
				);
			} else {
				// 无 import，在文件开头添加
				factoryContent = `import { KimiProvider } from "./kimi.js";\n${factoryContent}`;
			}

			// 添加 switch case（在 default 之前）
			factoryContent = factoryContent.replace(
				/default:\s*throw new Error\(`Unknown search provider: "\$\{name\}"`\);/,
				`case "kimi":\n\t\t\treturn new KimiProvider(apiKey);\n\t\tdefault:\n\t\t\tthrow new Error(\`Unknown search provider: "\${name}"\`);`,
			);

			writeFileSync(factoryPath, factoryContent, "utf-8");
			console.log("[patch-rpiv] Modified factory.ts");
		}

		// 3. 修改 providers/index.ts
		const indexPath = join(rpivPath, "providers", "index.ts");
		if (!existsSync(indexPath)) {
			console.warn("[patch-rpiv] index.ts not found at:", indexPath);
			return false;
		}

		let indexContent = readFileSync(indexPath, "utf-8");

		// 已 patch 检测
		if (indexContent.includes("KIMI_PROVIDER_META")) {
			console.log(
				"[patch-rpiv] index.ts already contains KIMI_PROVIDER_META, skipping",
			);
		} else {
			// 添加 import
			const firstImport = indexContent.match(
				/^(import\s+.*?from\s+["'].*?["'];)/m,
			);
			if (firstImport) {
				indexContent = indexContent.replace(
					firstImport[0],
					firstImport[0] + '\nimport { KIMI_PROVIDER_META } from "./kimi.js";',
				);
			} else {
				indexContent = `import { KIMI_PROVIDER_META } from "./kimi.js";\n${indexContent}`;
			}

			// 添加 re-export（锚定到行首）
			indexContent = indexContent.replace(
				/^export\s*\{/m,
				`export { KIMI_PROVIDER_META, KimiProvider } from "./kimi.js";\nexport {`,
			);

			// 添加 PROVIDERS 数组元素
			indexContent = indexContent.replace(
				/SEARXNG_PROVIDER_META,\s*\];/,
				"SEARXNG_PROVIDER_META,\n\tKIMI_PROVIDER_META,\n];",
			);

			writeFileSync(indexPath, indexContent, "utf-8");
			console.log("[patch-rpiv] Modified providers/index.ts");
		}

		console.log("[patch-rpiv] File-level patch applied successfully");
		return true;
	} catch (e) {
		console.warn("[patch-rpiv] File-level patch failed:", e);
		return false;
	}
}

// ---------------------------------------------------------------------------
// 顶层 API
// ---------------------------------------------------------------------------

/**
 * 主入口：将 Kimi Provider 注入 rpiv-web-tools
 *
 * 仅使用文件级文本插入（运行时 monkey-patch 因 ESM binding 限制已移除）。
 *
 * @returns 是否成功注入
 */
export async function patchRpivWebTools(): Promise<boolean> {
	const rpivPath = findRpivWebToolsPath();
	if (!rpivPath) {
		console.log("[patch-rpiv] rpiv-web-tools not found, skipping patch");
		return false;
	}

	console.log("[patch-rpiv] Found rpiv-web-tools at:", rpivPath);
	return await applyFileLevelPatch(rpivPath);
}
