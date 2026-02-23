import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
// 1. 型としての Vec3 をインポート（競合を避けるために別名にするか、型定義のみにする）
import type { Vec3 } from "vec3";
import { createTool, type ToolResponse, toolResult } from "../types";
/**
 * Collecting Domain: Autonomous tree felling.
 * 収集ドメイン：樹木の自動伐採を行います。
 */
export const fellTreesTool = createTool<void, { count: number }>({
	name: "collecting.felling",
	description: "Automatically finds and fells nearby trees. It also attempts to collect saplings.",
	inputSchema: {} as any,
	handler: async (bot: Bot): Promise<ToolResponse<{ count: number }>> => {
		// 1. Scan for logs
		// 周囲の原木をスキャン
		const logs = fellingScanner.findNearbyLogs(bot);

		if (logs.length === 0) {
			return toolResult.fail("No trees found in the vicinity.");
		}

		let felledCount = 0;

		try {
			// Pick the nearest tree (first in the scanned list)
			// 最も近い木（リストの最初）を選択
			const target = logs[0];

			// Equip axe if available
			// 斧を持っていれば装備
			const axe = bot.inventory
				.items()
				.find((item) => item.name.includes("axe") && !item.name.includes("pickaxe"));
			if (axe) await bot.equip(axe, "hand");

			// Navigate to the tree
			// 木の場所まで移動
			await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z));

			// Fell the log
			// 原木を伐採
			const block = bot.blockAt(target);
			if (block && block.name.includes("_log")) {
				await bot.dig(block);
				felledCount++;
			}

			return toolResult.ok(`Felled a tree block at ${target.x}, ${target.y}, ${target.z}.`, {
				count: felledCount,
			});
		} catch (err) {
			return toolResult.fail(
				`Felling interrupted: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

/**
 * Scanner for identifying trees
 * 樹木特定用スキャナー
 */
export const fellingScanner = {
	findNearbyLogs: (bot: Bot, radius = 24): Vec3[] => {
		// Find various types of logs
		// 各種原木（オーク、白樺、松など）をマッチング
		return bot.findBlocks({
			matching: (block: any) => block.name.endsWith("_log"),
			maxDistance: radius,
			count: 10,
		});
	},
};
