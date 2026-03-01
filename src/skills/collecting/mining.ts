import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const mineOresSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.mining",
	description:
		"Scans for and mines nearby ores. IMPORTANT: You MUST have a pickaxe equipped or in your inventory. " +
		"Mining with bare hands is extremely inefficient, takes too long, and results in NO item drops for most ores. " +
		"If you lack a pickaxe, craft one first instead of using this skill.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ minedCount: number }>> => {
		const { bot } = agent;

		const orePositions = miningScanner.findNearbyOres(bot);

		if (orePositions.length === 0) {
			return skillResult.fail("No valuable ores found nearby. Try moving to a different location.");
		}

		let minedCount = 0;
		const toolPlugin = (bot as any).tool;

		try {
			for (const pos of orePositions.slice(0, 3)) {
				const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 2);
				await agent.smartGoto(goal);

				const block = bot.blockAt(pos);
				if (block && (block.name.includes("ore") || block.name.includes("raw"))) {
					if (toolPlugin) {
						await toolPlugin.equipForBlock(block);
					}
					await agent.safeDig(block, signal);
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
	findNearbyOres: (bot: Bot, radius = 16): Vec3[] => {
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

		return bot.findBlocks({
			matching: (block: any) => targetOres.includes(block.name),
			maxDistance: radius,
			count: 10,
		});
	},
};
