import { goals } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";
import type { SafeBot } from "../../core/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

const SINGLE_SAPLING_TREES = ["oak", "birch", "acacia", "cherry"];
const QUAD_SAPLING_TREES = ["dark_oak", "spruce", "jungle"];

function getSaplingTypeFromLog(logName: string): string | null {
	const base = logName.replace(/_log|_wood|_stem|_hyphae$/, "");
	if (SINGLE_SAPLING_TREES.includes(base)) return base + "_sapling";
	if (QUAD_SAPLING_TREES.includes(base)) return base + "_sapling";
	return null;
}

function isQuadTree(saplingName: string): boolean {
	const base = saplingName.replace("_sapling", "");
	return QUAD_SAPLING_TREES.includes(base);
}

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
		if (!bot.entity) return skillResult.fail("Bot entity not loaded");

		const logs = woodScanner.findNearbyLogs(bot);

		let felledCount = 0;
		let plantedCount = 0;

		let treeTypeToPlant: string | null = null;
		if (logs.length > 0) {
			try {
				const target = logs[0];
				const toolPlugin = (bot as any).tool;

				const logBlock = bot.blockAt(target);
				if (logBlock) {
					treeTypeToPlant = getSaplingTypeFromLog(logBlock.name);
				}

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
						await agent.pickupNearbyItems(signal);
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

		if (!treeTypeToPlant) {
			const saplings = bot.inventory.items().filter((i) => i.name.endsWith("_sapling"));
			if (saplings.length > 0) {
				treeTypeToPlant = saplings[0].name;
			}
		}

		if (treeTypeToPlant) {
			const isQuad = isQuadTree(treeTypeToPlant);
			const placeable = findPlaceableForSaplings(bot, isQuad ? 12 : 8, isQuad);

			if (placeable.length > 0) {
				const target = placeable[0];
				await agent.abortableGoto(signal, new goals.GoalNear(target.x, target.y, target.z, 1));

				const sapling = bot.inventory.items().find((i) => i.name === treeTypeToPlant);
				if (sapling) {
					const block = bot.blockAt(target);
					if (block && (block.name === "dirt" || block.name === "grass_block")) {
						const Vec3 = require("vec3");

						if (isQuad) {
							const positions = [
								target,
								target.offset(1, 0, 0),
								target.offset(0, 0, 1),
								target.offset(1, 0, 1),
							];
							for (const pos of positions) {
								const soil = bot.blockAt(pos);
								if (soil && (soil.name === "dirt" || soil.name === "grass_block")) {
									const above = bot.blockAt(pos.offset(0, 1, 0));
									if (above && above.name === "air") {
										await bot.equip(sapling, "hand");
										await bot.placeBlock(soil, new Vec3(0, 1, 0));
										plantedCount++;
										await new Promise((r) => setTimeout(r, 100));
									}
								}
							}
						} else {
							await bot.equip(sapling, "hand");
							await bot.placeBlock(block, new Vec3(0, 1, 0));
							plantedCount++;
						}

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
	return (
		name.endsWith("_leaves") ||
		name.endsWith("_wart_block") ||
		name === "shroomlight" ||
		name === "dead_bush"
	);
}

function findPlaceableForSaplings(bot: SafeBot, radius: number, isQuad: boolean): Vec3[] {
	if (!bot.entity) return [];
	const candidates: { pos: Vec3; dist: number; gridScore: number }[] = [];
	const agentPos = bot.entity.position;

	const gridInterval = 3;
	const gridX = Math.floor(agentPos.x / gridInterval) * gridInterval;
	const gridZ = Math.floor(agentPos.z / gridInterval) * gridInterval;

	for (let dx = -radius; dx <= radius; dx++) {
		for (let dz = -radius; dz <= radius; dz++) {
			if (isQuad) {
				if (dx < 0 || dz < 0) continue;
				const checkPos = agentPos.offset(dx, 0, dz);
				const soil1 = bot.blockAt(checkPos);
				const soil2 = bot.blockAt(checkPos.offset(1, 0, 0));
				const soil3 = bot.blockAt(checkPos.offset(0, 0, 1));
				const soil4 = bot.blockAt(checkPos.offset(1, 0, 1));
				if (!soil1 || !soil2 || !soil3 || !soil4) continue;
				if (
					!isPlantable(soil1) ||
					!isPlantable(soil2) ||
					!isPlantable(soil3) ||
					!isPlantable(soil4)
				)
					continue;

				const above1 = bot.blockAt(checkPos.offset(0, 1, 0));
				const above2 = bot.blockAt(checkPos.offset(1, 1, 0));
				const above3 = bot.blockAt(checkPos.offset(0, 1, 1));
				const above4 = bot.blockAt(checkPos.offset(1, 1, 1));
				if (
					(above1 && above1.name !== "air") ||
					(above2 && above2.name !== "air") ||
					(above3 && above3.name !== "air") ||
					(above4 && above4.name !== "air")
				)
					continue;

				const dist = Math.abs(dx) + Math.abs(dz);
				if (dist >= 3) {
					const targetX = gridX + (dx > 0 ? gridInterval : 0);
					const targetZ = gridZ + (dz > 0 ? gridInterval : 0);
					const gridScore = Math.abs(targetX - checkPos.x) + Math.abs(targetZ - checkPos.z);
					candidates.push({ pos: checkPos, dist, gridScore });
				}
			} else {
				const checkPos = agentPos.offset(dx, 0, dz);
				const block = bot.blockAt(checkPos);
				if (!isPlantable(block)) continue;

				const above = bot.blockAt(checkPos.offset(0, 1, 0));
				if (above && above.name !== "air") continue;

				const dist = Math.abs(dx) + Math.abs(dz);
				if (dist >= 2) {
					const targetX = Math.floor(checkPos.x / gridInterval) * gridInterval;
					const targetZ = Math.floor(checkPos.z / gridInterval) * gridInterval;
					const gridScore = Math.abs(targetX - checkPos.x) + Math.abs(targetZ - checkPos.z);
					candidates.push({ pos: checkPos, dist, gridScore });
				}
			}
		}
	}

	candidates.sort((a, b) => {
		if (Math.abs(a.gridScore - b.gridScore) > 1) return a.gridScore - b.gridScore;
		return a.dist - b.dist;
	});
	return candidates.map((c) => c.pos);
}

function isPlantable(block: any): boolean {
	return block && (block.name === "dirt" || block.name === "grass_block");
}

export const woodScanner = {
	findNearbyLogs: (bot: SafeBot, radius = 24): Vec3[] => {
		if (!bot.entity) return [];
		const entityPos = bot.entity.position;
		return bot
			.findBlocks({
				matching: (block: any) => isLog(block.name),
				maxDistance: radius,
				count: 10,
			})
			.sort((a, b) => {
				return entityPos.distanceTo(a) - entityPos.distanceTo(b);
			});
	},
};
