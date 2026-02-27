import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

export const fellTreesTool = createTool<void, { count: number }>({
	name: "collecting.felling",
	description:
		"Automatically finds and fells nearby trees by moving next to them and digging safely.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<ToolResponse<{ count: number }>> => {
		const { bot } = agent;
		const logs = fellingScanner.findNearbyLogs(bot);

		if (logs.length === 0) return toolResult.fail("No trees found nearby.");

		let felledCount = 0;

		try {
			// 最も近い対数（ログ）を選択
			const target = logs[0];
			const axe = bot.inventory
				.items()
				.find((item) => item.name.includes("axe") && !item.name.includes("pickaxe"));
			if (axe) await bot.equip(axe, "hand");

			// --- 改善ポイント 1: GoalGetToBlock ではなく GoalLookAtBlock を使用 ---
			// ブロックそのものに入るのではなく、隣接した位置で停止するように距離を 3 に設定
			await agent.smartGoto(new goals.GoalLookAtBlock(target, bot.world, { reach: 3 }));

			// --- 改善ポイント 2: 垂直方向の全スキャン ---
			// その X, Z 座標に重なっている原木をすべて特定し、高い方から順に掘る
			const columnLogs: Vec3[] = [];
			for (let i = 0; i < 6; i++) {
				// 一般的な木は 5-6 ブロック
				const pos = target.offset(0, i, 0);
				const b = bot.blockAt(pos);
				if (b && isLog(b.name)) columnLogs.push(pos);
				else if (i > 0) break; // 途切れたら終了（地面より下は見ない）
			}

			// 高い位置から掘ることで、自分が原木の上に乗り上げて身動きが取れなくなるのを防ぐ
			for (const logPos of columnLogs.reverse()) {
				const block = bot.blockAt(logPos);
				if (block && bot.canDigBlock(block)) {
					await bot.dig(block);
					felledCount++;
				}
			}

			return toolResult.ok(
				`Successfully felled ${felledCount} blocks at ${target.x}, ${target.z}.`,
				{
					count: felledCount,
				},
			);
		} catch (err) {
			return toolResult.fail(`Felling failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
});

// ヘルパー: ブロック名判定
function isLog(name: string): boolean {
	return (
		name.endsWith("_log") ||
		name.endsWith("_wood") ||
		name.endsWith("_stem") ||
		name.endsWith("_hyphae")
	);
}

export const fellingScanner = {
	findNearbyLogs: (bot: Bot, radius = 24): Vec3[] => {
		return bot
			.findBlocks({
				matching: (block: any) => isLog(block.name),
				maxDistance: radius,
				count: 10,
			})
			.sort((a, b) => {
				// 距離順にソートして最も近いものを最初に持ってくる
				return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b);
			});
	},
};
