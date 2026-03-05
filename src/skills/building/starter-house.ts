import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingHouseSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.starter-house",
	description:
		"Builds a wooden box structure on the ground, then adds light, crafting table, furnace, chest, and door in order. Only registers base when structure is complete.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const pos = new Vec3(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z);

		agent.log(
			"[building.house] Started at position:",
			Math.floor(pos.x),
			Math.floor(pos.y),
			Math.floor(pos.z),
		);

		const installedItems: string[] = [];

		const dirtBlocks = ["dirt", "grass_block", "podzol", "mycelium"];
		const woodBlocks = [
			"oak_log",
			"birch_log",
			"spruce_log",
			"jungle_log",
			"acacia_log",
			"dark_oak_log",
		];
		const plankBlocks = [
			"oak_planks",
			"birch_planks",
			"spruce_planks",
			"jungle_planks",
			"acacia_planks",
			"dark_oak_planks",
		];

		const buildTargets = [
			{ x: -2, y: 0, z: -2 },
			{ x: -1, y: 0, z: -2 },
			{ x: 0, y: 0, z: -2 },
			{ x: 1, y: 0, z: -2 },
			{ x: 2, y: 0, z: -2 },
			{ x: -2, y: 0, z: 2 },
			{ x: -1, y: 0, z: 2 },
			{ x: 0, y: 0, z: 2 },
			{ x: 1, y: 0, z: 2 },
			{ x: 2, y: 0, z: 2 },
			{ x: -2, y: 0, z: -1 },
			{ x: -2, y: 0, z: 0 },
			{ x: -2, y: 0, z: 1 },
			{ x: 2, y: 0, z: -1 },
			{ x: 2, y: 0, z: 0 },
			{ x: 2, y: 0, z: 1 },
		];

		const wallTargets = buildTargets.filter(
			(t) => t.x === -2 || t.x === 2 || t.z === -2 || t.z === 2,
		);

		const unbreakableBlocks = [
			"bedrock",
			"obsidian",
			"end_portal",
			"end_gateway",
			"portal",
			"command_block",
			"repeating_command_block",
			"chain_command_block",
			"structure_block",
			"jigsaw",
		];

		agent.log("[building.house] Phase 0: Checking floor stability...");
		const unstableBlocks = ["water", "lava", "air", "void_air", "cave_air"];
		const interiorTargets = [
			{ x: -1, y: 0, z: -1 },
			{ x: 0, y: 0, z: -1 },
			{ x: 1, y: 0, z: -1 },
			{ x: -1, y: 0, z: 0 },
			{ x: 0, y: 0, z: 0 },
			{ x: 1, y: 0, z: 0 },
			{ x: -1, y: 0, z: 1 },
			{ x: 0, y: 0, z: 1 },
			{ x: 1, y: 0, z: 1 },
		];
		for (const offset of interiorTargets) {
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (!groundBlock || unstableBlocks.includes(groundBlock.name)) {
				agent.log(
					`[building.house] Failed: Unstable floor at ${offset.x},${offset.z}: ${groundBlock?.name || "none"}`,
				);
				return skillResult.fail(
					`Cannot build here: floor is unstable (${groundBlock?.name || "air"}).`,
				);
			}
		}

		agent.log("[building.house] Phase 0b: Checking for unbreakable blocks...");
		for (const offset of interiorTargets) {
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const block = bot.blockAt(targetPos);
			if (block && block.name !== "air" && unbreakableBlocks.includes(block.name)) {
				agent.log(`[building.house] Failed: Unbreakable block ${block.name} at interior`);
				return skillResult.fail(
					`Cannot build here: ${block.name} is in the way and cannot be broken.`,
				);
			}
		}
		for (const offset of wallTargets) {
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const block = bot.blockAt(targetPos);
			if (block && block.name !== "air" && unbreakableBlocks.includes(block.name)) {
				agent.log(`[building.house] Failed: Unbreakable block ${block.name} at wall`);
				return skillResult.fail(
					`Cannot build here: ${block.name} is in the way and cannot be broken.`,
				);
			}
		}
		agent.log("[building.house] Phase 0: Location check passed");

		agent.log("[building.house] Phase 1: Building walls...");
		let builtCount = 0;
		for (const offset of wallTargets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const groundPos = targetPos.offset(0, -1, 0);
			const block = bot.blockAt(targetPos);
			const groundBlock = bot.blockAt(groundPos);

			if (block && block.name === "air" && groundBlock && groundBlock.name !== "air") {
				const dirt = bot.inventory.items().find((i) => dirtBlocks.includes(i.name));
				const plank = bot.inventory.items().find((i) => plankBlocks.includes(i.name));
				const wood = bot.inventory.items().find((i) => woodBlocks.includes(i.name));
				const itemToPlace = dirt || plank || wood;

				if (itemToPlace) {
					await bot.equip(itemToPlace, "hand");
					try {
						await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
						builtCount++;
					} catch (e) {
						agent.log(`[building.house] Failed to place at ${offset.x},${offset.z}: ${e}`);
					}
				}
			}
		}

		if (builtCount < 8) {
			agent.log(`[building.house] Failed: Only built ${builtCount} walls`);
			return skillResult.fail(`Not enough walls built. Need at least 8, got ${builtCount}.`);
		}
		agent.log(`[building.house] Phase 1 complete: Built ${builtCount} walls`);
		installedItems.push("structure");

		agent.log("[building.house] Phase 2: Placing torch...");
		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			await bot.equip(torchItem, "hand");
			const centerPos = pos.offset(0, 1, 0);
			const groundPos = centerPos.offset(0, -1, 0);
			const blockAtCenter = bot.blockAt(centerPos);
			const groundBlock = bot.blockAt(groundPos);
			if (
				blockAtCenter &&
				blockAtCenter.name === "air" &&
				groundBlock &&
				groundBlock.name !== "air"
			) {
				try {
					await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
					installedItems.push("torch");
					agent.log("[building.house] Torch placed");
				} catch (e) {
					agent.log(`[building.house] Torch placement failed: ${e}`);
				}
			}
		}
		if (!installedItems.includes("torch")) {
			agent.log("[building.house] Failed: No torch");
			return skillResult.fail("Failed to place torch. Cannot proceed without light.");
		}

		agent.log("[building.house] Phase 3: Placing crafting table...");
		const table = await ensureCraftingTable(agent);
		if (!table) {
			agent.log("[building.house] Failed: Crafting table");
			return skillResult.fail("Failed to place crafting table.");
		}
		installedItems.push("crafting_table");
		agent.log("[building.house] Crafting table placed");

		agent.log("[building.house] Phase 4: Placing furnace...");
		const furnace = await ensureFurnace(agent);
		if (!furnace) {
			agent.log("[building.house] Failed: Furnace");
			return skillResult.fail("Failed to place furnace.");
		}
		installedItems.push("furnace");
		agent.log("[building.house] Furnace placed");

		agent.log("[building.house] Phase 5: Placing chest...");
		const chestItem = bot.inventory.items().find((i) => i.name === "chest");
		if (chestItem) {
			const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
			if (placed) {
				installedItems.push("chest");
				agent.log("[building.house] Chest placed");
			}
		} else {
			agent.log("[building.house] No chest in inventory");
		}

		agent.log("[building.house] Phase 6: Placing door...");
		const doorItem = bot.inventory.items().find((i) => i.name.endsWith("_door"));
		if (doorItem) {
			const placed = await tryPlaceBlock(
				bot,
				doorItem.name,
				bot.registry.blocksByName[doorItem.name].id,
				agent,
			);
			if (placed) {
				installedItems.push("door");
				agent.log("[building.house] Door placed");
			}
		} else {
			agent.log("[building.house] No door in inventory");
		}

		agent.log("[building.house] Phase 7: Registering base...");
		const baseId = `house_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "starter-house",
			position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
			safe: true,
			functional: true,
			hasStorage: installedItems.includes("chest"),
		});

		if (!registered) {
			agent.log("[building.house] Failed: Base too close to existing");
			return skillResult.fail("Base too close to existing base. Choose a different location.");
		}

		agent.log(`[building.house] Base ${baseId} registered: ${installedItems.join(", ")}`);

		agent.log("[building.house] Phase 8: Initial maintenance...");
		const maintenanceActions: string[] = [];

		const centerPos = pos.offset(0, 1, 0);
		const blockAtCenter = bot.blockAt(centerPos);
		if (!blockAtCenter || blockAtCenter.name !== "torch") {
			const torchItem = bot.inventory.items().find((i) => i.name === "torch");
			if (torchItem) {
				await bot.equip(torchItem, "hand");
				const groundPos = centerPos.offset(0, -1, 0);
				const groundBlock = bot.blockAt(groundPos);
				if (groundBlock && groundBlock.name !== "air") {
					try {
						await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
						maintenanceActions.push("torch_placed");
					} catch (e) {}
				}
			}
		}

		const validWallBlocks = [
			"dirt",
			"grass_block",
			"oak_planks",
			"birch_planks",
			"spruce_planks",
			"jungle_planks",
			"acacia_planks",
			"dark_oak_planks",
			"oak_log",
			"cobblestone",
			"stone",
		];
		let repairedCount = 0;
		for (const offset of wallTargets) {
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const block = bot.blockAt(targetPos);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (!block || block.name === "air") {
				if (groundBlock && groundBlock.name !== "air") {
					const dirt = bot.inventory.items().find((i) => dirtBlocks.includes(i.name));
					const plank = bot.inventory.items().find((i) => i.name.endsWith("_planks"));
					const itemToPlace = dirt || plank;
					if (itemToPlace) {
						await bot.equip(itemToPlace, "hand");
						try {
							await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
							repairedCount++;
						} catch (e) {}
					}
				}
			}
		}
		if (repairedCount > 0) {
			maintenanceActions.push(`walls_repaired:${repairedCount}`);
		}

		const finalItems = [...installedItems, ...maintenanceActions];
		agent.log(`[building.house] Maintenance: ${maintenanceActions.join(", ")}`);

		return skillResult.ok(`Built starter house. Items: ${finalItems.join(", ")}`, {
			baseId,
			items: finalItems,
		});
	},
});
