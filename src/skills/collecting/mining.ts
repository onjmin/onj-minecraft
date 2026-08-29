import type { BlockInfo, BotDriver } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const mineOresSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.mining",
	description:
		"Scans for and mines nearby ores. IMPORTANT: You MUST have a pickaxe equipped or in your inventory. " +
		"Mining with bare hands is extremely inefficient, takes too long, and results in NO item drops for most ores. " +
		"If you lack a pickaxe, craft one first instead of using this skill.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { driver } = agent;

		const orePositions = miningScanner.findNearbyOres(driver);

		if (orePositions.length === 0) {
			return skillResult.fail("No valuable ores found nearby. Try moving to a different location.");
		}

		let minedCount = 0;

		try {
			for (const ore of orePositions.slice(0, 3)) {
				await driver.goto(signal, { kind: "near", position: ore.position, distance: 2 });

				// 移動中にブロックが変わっていないか取り直して確認する
				const block = driver.world.blockAt(ore.position);
				if (block && (block.name.includes("ore") || block.name.includes("raw"))) {
					await driver.equipBestTool(block.position);
					await driver.dig(signal, block.position);
					minedCount++;
				}
			}

			return skillResult.ok(`Successfully extracted ${minedCount} ore blocks from the area.`, {
				minedCount,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Mining cancelled by combat");
			}
			return skillResult.fail(`Mining failed: ${errorMsg}`);
		}
	},
});

export const miningScanner = {
	findNearbyOres: (driver: BotDriver, radius = 16): BlockInfo[] => {
		const targetOres = [
			"coal_ore",
			"iron_ore",
			"gold_ore",
			"diamond_ore",
			"lapis_ore",
			"redstone_ore",
			"copper_ore",
			"emerald_ore",
			"deepslate_coal_ore",
			"deepslate_iron_ore",
			"deepslate_gold_ore",
			"deepslate_diamond_ore",
			"deepslate_lapis_ore",
			"deepslate_redstone_ore",
		];

		return driver.world.findBlocks(targetOres, radius, 10);
	},
};
