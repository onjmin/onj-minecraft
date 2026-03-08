import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectStoneSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.stone",
	description: "Collects stone-type blocks. Requires a pickaxe to successfully obtain stone.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { bot } = agent;

		// 石系ブロックを近場からスキャン
		const stonePositions = stoneScanner.findNearbyStone(bot);

		if (stonePositions.length === 0) {
			return skillResult.fail("No stone blocks found nearby. Try moving to a lower altitude.");
		}

		let minedCount = 0;
		const toolPlugin = (bot as any).tool;

		try {
			// 石は数が必要なので、上位10個をターゲットにする
			for (const pos of stonePositions) {
				const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 2);
				await agent.abortableGoto(signal, goal);

				const block = bot.blockAt(pos);
				// 移動中にブロックが変わっていないかチェック
				if (block && stoneScanner.isStone(block.name)) {
					if (toolPlugin) {
						// 適切なツール（ツルハシ）を装備
						await toolPlugin.equipForBlock(block);
					}
					await agent.abortableDig(signal, block);
					minedCount++;
				}
			}

			return skillResult.ok(`Successfully collected ${minedCount} stone-type blocks.`, {
				minedCount,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Stone collection interrupted by combat or system stop.");
			}
			return skillResult.fail(`Stone collection failed: ${errorMsg}`);
		}
	},
});

export const stoneScanner = {
	// 採集対象とする石系ブロックの定義
	stoneBlocks: ["stone", "cobblestone", "deepslate", "andesite", "diorite", "granite", "tuff"],

	isStone: (name: string): boolean => {
		return stoneScanner.stoneBlocks.includes(name);
	},

	findNearbyStone: (bot: Bot, radius = 8): Vec3[] => {
		return bot.findBlocks({
			matching: (block: any) => stoneScanner.isStone(block.name),
			maxDistance: radius,
			// 鉱石より出現率が高いため、一度の取得数を多めに設定
			count: 10,
		});
	},
};
