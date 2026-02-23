import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { Agent } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Farming Domain: Autonomous crop management.
 * 農業ドメイン：作物の自動管理（収穫と再植え付け）を行います。
 */
export const farmTendCropsTool = createTool<void, { harvestedCount: number }>({
	name: "collecting.farming",
	description:
		"Automatically harvests fully grown crops and replants seeds in the vicinity. Decisions are made autonomously.",
	inputSchema: {} as any,
	handler: async (agent: Agent): Promise<ToolResponse<{ harvestedCount: number }>> => {
		const { bot } = agent;
		// 1. Scan for harvestable crops (metadata 7)
		// 収穫可能な成熟した作物（メタデータ7）をスキャン
		const targets = farmingScanner.findHarvestableCrops(bot);

		if (targets.length === 0) {
			return toolResult.fail("No mature crops found to harvest.");
		}

		let harvestedCount = 0;

		try {
			for (const pos of targets) {
				// Navigate to the target crop
				// ターゲットの作物の場所まで移動
				await agent.smartGoto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));

				const block = bot.blockAt(pos);
				// Check again if it's still harvestable
				// まだ収穫可能か再確認
				if (block && block.metadata === 7) {
					const cropName = block.name;
					await bot.dig(block);
					harvestedCount++;

					// 2. Attempt to replant if seeds are available
					// 種を持っている場合は再植え付けを試みる
					const seedName = getSeedName(cropName);
					const seed = bot.inventory.items().find((item) => item.name === seedName);

					if (seed) {
						const farmland = bot.blockAt(pos.offset(0, -1, 0));
						if (farmland && farmland.name === "farmland") {
							await bot.equip(seed, "hand");
							// Use vec3 for the face vector (upwards)
							// vec3 を使用してブロックの上面を指定
							const Vec3 = require("vec3");
							await bot.placeBlock(farmland, new Vec3(0, 1, 0));
						}
					}
				}
			}

			return toolResult.ok(`Successfully harvested and managed ${harvestedCount} crops.`, {
				harvestedCount,
			});
		} catch (err) {
			return toolResult.fail(
				`Farming operation interrupted: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

/**
 * Specialized scanner for farming activities
 * 農業活動用のスキャナー
 */
export const farmingScanner = {
	findHarvestableCrops: (bot: Bot, radius = 16): Vec3[] => {
		const cropNames = ["wheat", "carrots", "potatoes", "beetroots"];
		return bot.findBlocks({
			matching: (block: any) => cropNames.includes(block.name) && block.metadata === 7,
			maxDistance: radius,
			count: 10, // Process 10 blocks at a time for efficiency
		});
	},
};

/**
 * Resolves the corresponding seed name for a given crop
 * 作物名に対応する種アイテム名を解決
 */
function getSeedName(cropName: string): string {
	switch (cropName) {
		case "wheat":
			return "wheat_seeds";
		case "beetroots":
			return "beetroot_seeds";
		case "carrots":
			return "carrot";
		case "potatoes":
			return "potato";
		default:
			return "";
	}
}
