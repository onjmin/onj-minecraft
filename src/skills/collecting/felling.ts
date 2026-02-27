import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const fellTreesSkill = createSkill<void, { count: number }>({
	name: "collecting.felling",
	description:
		"Automatically finds and fells nearby trees using collectBlock plugin. The bot will move to trees and harvest them automatically.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<SkillResponse<{ count: number }>> => {
		const { bot } = agent;
		const logs = fellingScanner.findNearbyLogs(bot);

		if (logs.length === 0) return skillResult.fail("No trees found nearby.");

		try {
			const target = logs[0];
			const collectBot = bot as any;

			if (!collectBot.collectBlock) {
				return skillResult.fail("collectBlock plugin not loaded");
			}

			const result = await collectBot.collectBlock.collect(logs, {
				ignoreNoPath: true,
				enableAutoTool: true,
			});

			const felledCount = result.length;

			return skillResult.ok(
				`Successfully felled ${felledCount} blocks at ${target.x}, ${target.z}.`,
				{ count: felledCount },
			);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
				return skillResult.fail("Felling cancelled by combat");
			}
			return skillResult.fail(`Felling failed: ${errorMsg}`);
		}
	},
});

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
				return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b);
			});
	},
};
