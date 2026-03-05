import type { Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const collectWoodSkill = createSkill<void, { felledCount: number; plantedCount: number }>({
	name: "collecting.wood",
	description:
		"Automatically finds and fells nearby trees, including clearing leaves to move safely. Also plants saplings on dirt/grass and uses bone meal to grow them.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ felledCount: number; plantedCount: number }>> => {
		const { bot } = agent;
		const logs = woodScanner.findNearbyLogs(bot);

		let felledCount = 0;
		let plantedCount = 0;

		if (logs.length > 0) {
			try {
				const target = logs[0];
				const toolPlugin = (bot as any).tool;

				const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
				await agent.abortableGoto(signal, goal);

				const blocksToRemove: Vec3[] = [];
				for (let x = -1; x <= 1; x++) {
					for (let z = -1; z <= 1; z++) {
						for (let y = 0; y <= 6; y++) {
							const pos = target.offset(x, y, z);
							const b = bot.blockAt(pos);
							if (b && (isLog(b.name) || isLeaves(b.name))) {
								blocksToRemove.push(pos);
							}
						}
					}
				}

				const botY = bot.entity.position.y;
				blocksToRemove.sort((a, b) => {
					const distA = Math.abs(a.y - (botY + 1.5));
					const distB = Math.abs(b.y - (botY + 1.5));
					return distA - distB;
				});

				for (const pos of blocksToRemove) {
					const block = bot.blockAt(pos);
					if (block && block.name !== "air" && bot.canDigBlock(block)) {
						if (toolPlugin) {
							await toolPlugin.equipForBlock(block);
						}
						await agent.abortableDig(signal, block);
						felledCount++;
						await agent.pickupNearbyItems();
					}
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
					return skillResult.fail("Wood cancelled by combat");
				}
				return skillResult.fail(`Wood failed: ${errorMsg}`);
			}
		}

		const placeable = findPlaceableForSaplings(bot);
		if (placeable.length > 0) {
			const target = placeable[0];
			await agent.abortableGoto(signal, new goals.GoalNear(target.x, target.y, target.z, 1));

			const sapling = bot.inventory.items().find((i) => i.name.endsWith("_sapling"));
			if (sapling) {
				const block = bot.blockAt(target);
				if (block && (block.name === "dirt" || block.name === "grass_block")) {
					await bot.equip(sapling, "hand");
					const Vec3 = require("vec3");
					await bot.placeBlock(block, new Vec3(0, 1, 0));
					plantedCount++;

					const boneMeal = bot.inventory.items().find((i) => i.name === "bone_meal");
					if (boneMeal) {
						await bot.equip(boneMeal, "hand");
						const saplingBlock = bot.blockAt(target.offset(0, 1, 0));
						if (saplingBlock) {
							try {
								await bot.activateBlock(saplingBlock);
								await new Promise((r) => setTimeout(r, 200));
							} catch (e) {
								agent.log(`[collecting.wood] Bone meal failed: ${e}`);
							}
						}
					}
				}
			}
		}

		if (felledCount === 0 && plantedCount === 0) {
			return skillResult.fail("No trees to fell and no suitable dirt/grass for planting.");
		}

		return skillResult.ok(`Felled ${felledCount} blocks, planted ${plantedCount} sapling(s).`, {
			felledCount,
			plantedCount,
		});
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

function isLeaves(name: string): boolean {
	return name.endsWith("_leaves") || name.endsWith("_wart_block") || name === "shroomlight";
}

function findPlaceableForSaplings(bot: Bot, radius = 8): Vec3[] {
	const candidates: { pos: Vec3; dist: number }[] = [];
	const agentPos = bot.entity.position;

	for (let dx = -radius; dx <= radius; dx++) {
		for (let dz = -radius; dz <= radius; dz++) {
			const checkPos = agentPos.offset(dx, 0, dz);
			const block = bot.blockAt(checkPos);
			if (!block || (block.name !== "dirt" && block.name !== "grass_block")) continue;

			const above = bot.blockAt(checkPos.offset(0, 1, 0));
			if (above && above.name !== "air") continue;

			const dist = Math.abs(dx) + Math.abs(dz);
			candidates.push({ pos: checkPos, dist });
		}
	}

	candidates.sort((a, b) => a.dist - b.dist);
	return candidates.map((c) => c.pos);
}

export const woodScanner = {
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
