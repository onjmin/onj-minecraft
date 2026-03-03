import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Farming Domain: Autonomous crop management.
 * 農業ドメイン：作物の自動管理（収穫と再植え付け）を行います。
 */
export const farmTendCropsSkill = createSkill<void, { harvestedCount: number }>({
	name: "collecting.farming",
	description:
		"Automatically harvests fully grown crops and replants seeds in the vicinity. If you have dirt and there's water nearby but no available farmland, this will create new farmland. Decisions are made autonomously.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ harvestedCount: number }>> => {
		const { bot } = agent;

		const targets = farmingScanner.findHarvestableCrops(bot);
		const placeableNearWater = farmingScanner.findPlaceableForFarmland(bot);

		if (targets.length === 0 && placeableNearWater.length === 0) {
			const hasDirt = bot.inventory.items().find((i) => i.name === "dirt");
			if (hasDirt) {
				const hasWater = farmingScanner.findWaterNearby(bot);
				if (!hasWater) {
					return skillResult.fail("No mature crops to harvest, no water nearby for farmland.");
				}
				return skillResult.fail("No mature crops found to harvest.");
			}
			return skillResult.fail("No mature crops found to harvest.");
		}

		if (targets.length === 0 && placeableNearWater.length > 0) {
			const hasHoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
			if (hasHoe) {
				agent.log(`[farming] Creating new farmland near water...`);
				const pos = placeableNearWater[0];
				const tillBlock = bot.blockAt(pos);
				if (tillBlock && (tillBlock.name === "dirt" || tillBlock.name === "grass_block")) {
					await agent.abortableGoto(signal, new goals.GoalNear(pos.x, pos.y, pos.z, 1));
					await bot.equip(hasHoe, "hand");
					try {
						await bot.placeBlock(tillBlock, new (require("vec3"))(0, 1, 0));
						await new Promise((r) => setTimeout(r, 500));
						return skillResult.ok("Created new farmland near water.", { harvestedCount: 0 });
					} catch (e) {
						agent.log(`[farming] Failed to till: ${e}`);
					}
				}
			} else {
				return skillResult.fail("Need a hoe to create farmland.");
			}
		}

		let harvestedCount = 0;

		try {
			for (const pos of targets) {
				// Navigate to the target crop
				// ターゲットの作物の場所まで移動
				await agent.abortableGoto(signal, new goals.GoalGetToBlock(pos.x, pos.y, pos.z));

				const block = bot.blockAt(pos);
				// Check again if it's still harvestable
				// まだ収穫可能か再確認
				if (block && block.metadata === 7) {
					const cropName = block.name;
					const toolPlugin = (bot as any).tool;
					if (toolPlugin) {
						await toolPlugin.equipForBlock(block);
					}
					await agent.abortableDig(signal, block);
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

			return skillResult.ok(`Managed ${harvestedCount} crops.`, {
				harvestedCount,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Farming cancelled by combat");
			}
			return skillResult.fail(`Farming failed: ${errorMsg}`);
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
			count: 10,
		});
	},

	findWaterNearby: (bot: Bot, radius = 8): boolean => {
		return (
			bot.findBlocks({
				matching: (block: any) => block.name === "water",
				maxDistance: radius,
				count: 1,
			}).length > 0
		);
	},

	findPlaceableForFarmland: (bot: Bot, radius = 8): Vec3[] => {
		const candidates: { pos: Vec3; dist: number }[] = [];
		const agentPos = bot.entity.position;

		for (let dx = -radius; dx <= radius; dx++) {
			for (let dz = -radius; dz <= radius; dz++) {
				for (let dy = -2; dy <= 2; dy++) {
					const checkPos = agentPos.offset(dx, dy, dz);
					const block = bot.blockAt(checkPos);
					if (!block || (block.name !== "dirt" && block.name !== "grass_block")) continue;

					const above = bot.blockAt(checkPos.offset(0, 1, 0));
					if (above && above.name !== "air") continue;

					const hasWaterNearby =
						bot.findBlocks({
							matching: (b: any) => b.name === "water",
							maxDistance: 4,
							count: 1,
							point: checkPos,
						}).length > 0;

					if (hasWaterNearby) {
						const dist = Math.abs(dx) + Math.abs(dz);
						candidates.push({ pos: checkPos, dist });
					}
				}
			}
		}

		candidates.sort((a, b) => a.dist - b.dist);
		return candidates.map((c) => c.pos);
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
