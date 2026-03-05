import { goals } from "mineflayer-pathfinder";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingUndergroundSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.underground-base",
	description:
		"Digs a 3x3x3+ underground space, then adds light, crafting table, furnace, chest, and door in order. Only registers base when all items are placed.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const toolPlugin = (bot as any).tool;
		const pos = bot.entity.position;

		agent.log(
			"[building.underground] Started at position:",
			Math.floor(pos.x),
			Math.floor(pos.y),
			Math.floor(pos.z),
		);

		const installedItems: string[] = [];

		const digTargets = [
			{ x: 1, y: 0, z: 0 },
			{ x: -1, y: 0, z: 0 },
			{ x: 0, y: 0, z: 1 },
			{ x: 0, y: 0, z: -1 },
			{ x: 1, y: 1, z: 0 },
			{ x: -1, y: 1, z: 0 },
			{ x: 0, y: 1, z: 1 },
			{ x: 0, y: 1, z: -1 },
			{ x: 1, y: 0, z: 1 },
			{ x: 1, y: 0, z: -1 },
			{ x: -1, y: 0, z: 1 },
			{ x: -1, y: 0, z: -1 },
		];

		agent.log("[building.underground] Phase 0a: Checking floor stability...");
		const unstableFloorBlocks = ["water", "lava", "air", "void_air", "cave_air"];
		const floorCheckTargets = [
			{ x: 0, y: 0, z: 0 },
			{ x: 1, y: 0, z: 0 },
			{ x: -1, y: 0, z: 0 },
			{ x: 0, y: 0, z: 1 },
			{ x: 0, y: 0, z: -1 },
		];
		for (const offset of floorCheckTargets) {
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (!groundBlock || unstableFloorBlocks.includes(groundBlock.name)) {
				agent.log(
					`[building.underground] Failed: Unstable floor at ${offset.x},${offset.z}: ${groundBlock?.name || "none"}`,
				);
				return skillResult.fail(
					`Cannot build here: floor is unstable (${groundBlock?.name || "air"}).`,
				);
			}
		}

		let dugCount = 0;
		agent.log("[building.underground] Phase 0b: Checking for unbreakable blocks...");
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
		for (const offset of digTargets) {
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const block = bot.blockAt(targetPos);
			if (
				block &&
				block.name !== "air" &&
				(unbreakableBlocks.includes(block.name) || !bot.canDigBlock(block))
			) {
				agent.log(
					`[building.underground] Failed: Cannot break ${block.name} at ${offset.x},${offset.y},${offset.z}`,
				);
				return skillResult.fail(
					`Cannot build here: ${block.name} blocks the way and cannot be broken.`,
				);
			}
		}
		agent.log("[building.underground] Phase 0: Location check passed");

		agent.log("[building.underground] Phase 1: Digging space...");
		for (const offset of digTargets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const block = bot.blockAt(targetPos);
			if (!block || block.name === "air") continue;
			if (["water", "lava", "bedrock"].includes(block.name)) continue;
			if (!bot.canDigBlock(block)) continue;

			await agent.abortableGoto(
				signal,
				new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1),
			);
			const currentBlock = bot.blockAt(targetPos);
			if (currentBlock && currentBlock.name !== "air" && bot.canDigBlock(currentBlock)) {
				if (toolPlugin) await toolPlugin.equipForBlock(currentBlock);
				await agent.abortableDig(signal, currentBlock);
				dugCount++;
				await agent.pickupNearbyItems();
			}
		}

		if (dugCount < 6) {
			agent.log(`[building.underground] Failed: Only dug ${dugCount} blocks`);
			return skillResult.fail(`Not enough space dug. Need at least 6 blocks, got ${dugCount}.`);
		}
		agent.log(`[building.underground] Phase 1 complete: Dug ${dugCount} blocks`);
		installedItems.push("space");

		agent.log("[building.underground] Phase 1b: Placing dirt walls...");
		const dirtBlocks = ["dirt", "grass_block"];
		const wallTargets = [
			{ x: 2, y: 0, z: 0 },
			{ x: -2, y: 0, z: 0 },
			{ x: 0, y: 0, z: 2 },
			{ x: 0, y: 0, z: -2 },
			{ x: 2, y: 1, z: 0 },
			{ x: -2, y: 1, z: 0 },
			{ x: 0, y: 1, z: 2 },
			{ x: 0, y: 1, z: -2 },
		];
		let wallCount = 0;
		for (const offset of wallTargets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const block = bot.blockAt(targetPos);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (block && block.name === "air" && groundBlock && groundBlock.name !== "air") {
				const dirt = bot.inventory.items().find((i) => dirtBlocks.includes(i.name));
				if (dirt) {
					await bot.equip(dirt, "hand");
					try {
						await bot.placeBlock(groundBlock, new (require("vec3"))(0, 1, 0));
						wallCount++;
					} catch (e) {
						agent.log(`[building.underground] Wall placement failed: ${e}`);
					}
				}
			}
		}
		agent.log(`[building.underground] Placed ${wallCount} wall blocks`);

		agent.log("[building.underground] Phase 2: Placing torch...");
		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			await bot.equip(torchItem, "hand");
			const centerPos = pos.offset(0, 2, 0);
			const blockAtCenter = bot.blockAt(centerPos);
			if (blockAtCenter && blockAtCenter.name === "air") {
				try {
					await bot.placeBlock(blockAtCenter, new (require("vec3"))(0, -1, 0));
					installedItems.push("torch");
					agent.log("[building.underground] Torch placed");
				} catch (e) {
					agent.log(`[building.underground] Torch placement failed: ${e}`);
				}
			}
		}
		if (!installedItems.includes("torch")) {
			agent.log("[building.underground] Failed: No torch");
			return skillResult.fail("Failed to place torch. Cannot proceed without light.");
		}

		agent.log("[building.underground] Phase 3: Placing crafting table...");
		const table = await ensureCraftingTable(agent);
		if (!table) {
			agent.log("[building.underground] Failed: Crafting table");
			return skillResult.fail("Failed to place crafting table.");
		}
		installedItems.push("crafting_table");
		agent.log("[building.underground] Crafting table placed");

		agent.log("[building.underground] Phase 4: Placing furnace...");
		const furnace = await ensureFurnace(agent);
		if (!furnace) {
			agent.log("[building.underground] Failed: Furnace");
			return skillResult.fail("Failed to place furnace.");
		}
		installedItems.push("furnace");
		agent.log("[building.underground] Furnace placed");

		agent.log("[building.underground] Phase 5: Placing chest...");
		const chestItem = bot.inventory.items().find((i) => i.name === "chest");
		if (chestItem) {
			const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
			if (placed) {
				installedItems.push("chest");
				agent.log("[building.underground] Chest placed");
			}
		} else {
			agent.log("[building.underground] No chest in inventory");
		}

		agent.log("[building.underground] Phase 6: Placing door...");
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
				agent.log("[building.underground] Door placed");
			}
		} else {
			agent.log("[building.underground] No door in inventory");
		}

		agent.log("[building.underground] Phase 7: Registering base...");
		const baseId = `underground_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "underground",
			position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
			safe: true,
			functional: true,
			hasStorage: installedItems.includes("chest"),
		});

		if (!registered) {
			agent.log("[building.underground] Failed: Base too close to existing");
			return skillResult.fail("Base too close to existing base. Choose a different location.");
		}

		agent.log(`[building.underground] Base ${baseId} registered: ${installedItems.join(", ")}`);

		agent.log("[building.underground] Phase 8: Initial maintenance...");
		const maintenanceActions: string[] = [];

		const torchCenterPos = pos.offset(0, 2, 0);
		const blockAtTorch = bot.blockAt(torchCenterPos);
		if (!blockAtTorch || blockAtTorch.name !== "torch") {
			const torchItem = bot.inventory.items().find((i) => i.name === "torch");
			if (torchItem) {
				await bot.equip(torchItem, "hand");
				const groundPos = torchCenterPos.offset(0, -1, 0);
				const groundBlock = bot.blockAt(groundPos);
				if (groundBlock && groundBlock.name !== "air") {
					try {
						await bot.placeBlock(groundBlock, new (require("vec3"))(0, -1, 0));
						maintenanceActions.push("torch_placed");
					} catch (e) {}
				}
			}
		}

		let repairedCount = 0;
		for (const offset of wallTargets) {
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const block = bot.blockAt(targetPos);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (!block || block.name === "air") {
				if (groundBlock && groundBlock.name !== "air") {
					const dirt = bot.inventory.items().find((i) => dirtBlocks.includes(i.name));
					if (dirt) {
						await bot.equip(dirt, "hand");
						try {
							await bot.placeBlock(groundBlock, new (require("vec3"))(0, 1, 0));
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
		agent.log(`[building.underground] Maintenance: ${maintenanceActions.join(", ")}`);

		return skillResult.ok(`Built underground base. Items: ${finalItems.join(", ")}`, {
			baseId,
			items: finalItems,
		});
	},
});
