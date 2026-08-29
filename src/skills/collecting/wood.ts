import type { BlockInfo, BotDriver, Position } from "../../core/driver/types";
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
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");

		const logs = woodScanner.findNearbyLogs(driver);

		let felledCount = 0;
		let plantedCount = 0;

		let treeTypeToPlant: string | null = null;
		if (logs.length > 0) {
			try {
				const target = logs[0].position;

				treeTypeToPlant = getSaplingTypeFromLog(logs[0].name);

				await driver.goto(signal, { kind: "near", position: target, distance: 2 });

				const blocksToRemove: Position[] = [];
				for (let x = -1; x <= 1; x++) {
					for (let z = -1; z <= 1; z++) {
						for (let y = 0; y <= 6; y++) {
							const pos = { x: target.x + x, y: target.y + y, z: target.z + z };
							const b = driver.world.blockAt(pos);
							if (b && (isLog(b.name) || isLeaves(b.name))) {
								blocksToRemove.push(pos);
							}
						}
					}
				}

				const botY = driver.getState().position.y;
				blocksToRemove.sort((a, b) => {
					const distA = Math.abs(a.y - (botY + 1.5));
					const distB = Math.abs(b.y - (botY + 1.5));
					return distA - distB;
				});

				for (const pos of blocksToRemove) {
					const block = driver.world.blockAt(pos);
					if (block && block.name !== "air" && block.diggable) {
						await driver.equipBestTool(pos);
						await driver.dig(signal, pos);
						felledCount++;
						await driver.pickupNearbyItems(signal);
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
			const saplings = driver.inventory.items().filter((i) => i.name.endsWith("_sapling"));
			if (saplings.length > 0) {
				treeTypeToPlant = saplings[0].name;
			}
		}

		if (treeTypeToPlant) {
			const isQuad = isQuadTree(treeTypeToPlant);
			const placeable = findPlaceableForSaplings(driver, isQuad ? 12 : 8, isQuad);

			if (placeable.length > 0) {
				const target = placeable[0];
				await driver.goto(signal, { kind: "near", position: target, distance: 1 });

				const sapling = driver.inventory.items().find((i) => i.name === treeTypeToPlant);
				if (sapling) {
					const block = driver.world.blockAt(target);
					if (block && (block.name === "dirt" || block.name === "grass_block")) {
						// 上面(0,1,0)に設置する
						const UP: Position = { x: 0, y: 1, z: 0 };

						if (isQuad) {
							const positions: Position[] = [
								target,
								{ ...target, x: target.x + 1 },
								{ ...target, z: target.z + 1 },
								{ ...target, x: target.x + 1, z: target.z + 1 },
							];
							for (const pos of positions) {
								const soil = driver.world.blockAt(pos);
								if (soil && (soil.name === "dirt" || soil.name === "grass_block")) {
									const above = driver.world.blockAt({ ...pos, y: pos.y + 1 });
									if (above && above.name === "air") {
										await driver.equip(sapling.name, "hand");
										await driver.placeBlock(signal, pos, UP);
										plantedCount++;
										await new Promise((r) => setTimeout(r, 100));
									}
								}
							}
						} else {
							await driver.equip(sapling.name, "hand");
							await driver.placeBlock(signal, target, UP);
							plantedCount++;
						}

						const boneMeal = driver.inventory.items().find((i) => i.name === "bone_meal");
						if (boneMeal) {
							await driver.equip(boneMeal.name, "hand");
							const saplingPos: Position = { ...target, y: target.y + 1 };
							if (driver.world.blockAt(saplingPos)) {
								try {
									await driver.activateBlock(saplingPos);
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

function findPlaceableForSaplings(driver: BotDriver, radius: number, isQuad: boolean): Position[] {
	const state = driver.getState();
	if (!state.isReady) return [];
	const candidates: { pos: Position; dist: number; gridScore: number }[] = [];
	const agentPos = state.position;
	const at = (dx: number, dy: number, dz: number): Position => ({
		x: Math.floor(agentPos.x) + dx,
		y: Math.floor(agentPos.y) + dy,
		z: Math.floor(agentPos.z) + dz,
	});

	const gridInterval = 3;
	const gridX = Math.floor(agentPos.x / gridInterval) * gridInterval;
	const gridZ = Math.floor(agentPos.z / gridInterval) * gridInterval;

	for (let dx = -radius; dx <= radius; dx++) {
		for (let dz = -radius; dz <= radius; dz++) {
			if (isQuad) {
				if (dx < 0 || dz < 0) continue;
				const checkPos = at(dx, 0, dz);
				const soil1 = driver.world.blockAt(checkPos);
				const soil2 = driver.world.blockAt({ ...checkPos, x: checkPos.x + 1 });
				const soil3 = driver.world.blockAt({ ...checkPos, z: checkPos.z + 1 });
				const soil4 = driver.world.blockAt({ ...checkPos, x: checkPos.x + 1, z: checkPos.z + 1 });
				if (!soil1 || !soil2 || !soil3 || !soil4) continue;
				if (
					!isPlantable(soil1) ||
					!isPlantable(soil2) ||
					!isPlantable(soil3) ||
					!isPlantable(soil4)
				)
					continue;

				const y = checkPos.y + 1;
				const above1 = driver.world.blockAt({ ...checkPos, y });
				const above2 = driver.world.blockAt({ x: checkPos.x + 1, y, z: checkPos.z });
				const above3 = driver.world.blockAt({ x: checkPos.x, y, z: checkPos.z + 1 });
				const above4 = driver.world.blockAt({ x: checkPos.x + 1, y, z: checkPos.z + 1 });
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
				const checkPos = at(dx, 0, dz);
				const block = driver.world.blockAt(checkPos);
				if (!isPlantable(block)) continue;

				const above = driver.world.blockAt({ ...checkPos, y: checkPos.y + 1 });
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

function isPlantable(block: BlockInfo | null): boolean {
	return block !== null && (block.name === "dirt" || block.name === "grass_block");
}

export const woodScanner = {
	findNearbyLogs: (driver: BotDriver, radius = 24): BlockInfo[] => {
		const state = driver.getState();
		if (!state.isReady) return [];
		const origin = state.position;
		const distanceTo = (p: Position) => Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
		return driver.world
			.findBlocksMatching((name) => isLog(name), radius, 10)
			.sort((a, b) => distanceTo(a.position) - distanceTo(b.position));
	},
};
