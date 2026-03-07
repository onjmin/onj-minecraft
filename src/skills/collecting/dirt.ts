import { goals } from "mineflayer-pathfinder";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectDirtSkill = createSkill<void, { count: number }>({
	name: "collecting.dirt",
	description:
		"Collects dirt blocks for scaffolding or building base walls. Digs nearby dirt/grass blocks.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ count: number }>> => {
		const { bot } = agent;
		const toolPlugin = (bot as any).tool;

		const dirtBlocks = bot.findBlocks({
			matching: (b: any) => b.name === "dirt" || b.name === "grass_block",
			maxDistance: 16,
			count: 20,
		});

		if (dirtBlocks.length === 0) {
			return skillResult.fail("No dirt or grass blocks found nearby.");
		}

		agent.log(`[collecting.dirt] Found ${dirtBlocks.length} dirt blocks`);

		let collected = 0;
		const maxCollect = 16;

		for (const pos of dirtBlocks) {
			if (collected >= maxCollect) break;
			if (agent.checkAbort(signal)) break;

			const block = bot.blockAt(pos);
			if (!block || !bot.canDigBlock(block)) continue;

			await agent.abortableGoto(signal, new goals.GoalNear(pos.x, pos.y, pos.z, 1));

			const currentBlock = bot.blockAt(pos);
			if (currentBlock && bot.canDigBlock(currentBlock)) {
				if (toolPlugin) {
					await toolPlugin.equipForBlock(currentBlock);
				}
				await agent.abortableDig(signal, currentBlock);
				collected++;
				await agent.pickupNearbyItems(signal);
			}
		}

		agent.log(`[collecting.dirt] Collected ${collected} dirt blocks`);

		return skillResult.ok(`Collected ${collected} dirt blocks.`, { count: collected });
	},
});
