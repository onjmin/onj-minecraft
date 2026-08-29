import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectDirtSkill = createSkill<void, { count: number }>({
	name: "collecting.dirt",
	description:
		"Collects dirt blocks for scaffolding or building base walls. Digs nearby dirt/grass blocks.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ count: number }>> => {
		const { driver } = agent;

		const dirtBlocks = driver.world.findBlocks(["dirt", "grass_block"], 16, 20);

		if (dirtBlocks.length === 0) {
			return skillResult.fail("No dirt or grass blocks found nearby.");
		}

		agent.log(`[collecting.dirt] Found ${dirtBlocks.length} dirt blocks`);

		let collected = 0;
		const maxCollect = 16;

		for (const block of dirtBlocks) {
			if (collected >= maxCollect) break;
			if (agent.checkAbort(signal)) break;

			if (!block.diggable) continue;

			await driver.goto(signal, { kind: "near", position: block.position, distance: 1 });

			// 移動中に地形が変わりうるので取り直す
			const currentBlock = driver.world.blockAt(block.position);
			if (currentBlock?.diggable) {
				await driver.equipBestTool(block.position);
				await driver.dig(signal, block.position);
				collected++;
				await driver.pickupNearbyItems(signal);
			}
		}

		agent.log(`[collecting.dirt] Collected ${collected} dirt blocks`);

		return skillResult.ok(`Collected ${collected} dirt blocks.`, { count: collected });
	},
});
