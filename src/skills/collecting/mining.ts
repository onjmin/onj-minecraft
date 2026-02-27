import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const mineOresSkill = createSkill<void, { minedCount: number }>({
	name: "collecting.mining",
	description:
		"Scans for and mines nearby ores using collectBlock plugin. The bot will automatically select the best tool and mine ores. If you lack a pickaxe, craft one first.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<SkillResponse<{ minedCount: number }>> => {
		const { bot } = agent;

		const orePositions = miningScanner.findNearbyOres(bot);

		if (orePositions.length === 0) {
			return skillResult.fail("No valuable ores found nearby. Try moving to a different location.");
		}

		try {
			const target = orePositions[0];
			const collectBot = bot as any;

			if (!collectBot.collectBlock) {
				return skillResult.fail("collectBlock plugin not loaded");
			}

			const result = await collectBot.collectBlock.collect(target, {
				ignoreNoPath: true,
				enableAutoTool: true,
			});

			const minedCount = result.length;

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
