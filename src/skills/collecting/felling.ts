import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const fellTreesSkill = createSkill<void, { count: number }>({
	name: "collecting.felling",
	description:
		"Automatically finds and fells nearby trees by moving next to them and digging safely.",
	inputSchema: {} as any,
	handler: async (agent: AgentOrchestrator): Promise<SkillResponse<{ count: number }>> => {
		const { bot } = agent;
		const logs = fellingScanner.findNearbyLogs(bot);

		if (logs.length === 0) return skillResult.fail("No trees found nearby.");

		let felledCount = 0;

		try {
			const target = logs[0];
			const toolPlugin = (bot as any).tool;

			const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
			await agent.smartGoto(goal);

			const columnLogs: Vec3[] = [];
			for (let i = 0; i < 6; i++) {
				const pos = target.offset(0, i, 0);
				const b = bot.blockAt(pos);
				if (b && isLog(b.name)) columnLogs.push(pos);
				else if (i > 0) break;
			}

			for (const logPos of columnLogs.reverse()) {
				const block = bot.blockAt(logPos);
				if (block && bot.canDigBlock(block)) {
					if (toolPlugin) {
						await toolPlugin.equipForBlock(block);
					}
					await bot.dig(block);
					felledCount++;
				}
			}

			return skillResult.ok(
				`Successfully felled ${felledCount} blocks at ${target.x}, ${target.z}.`,
				{
					count: felledCount,
				},
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
