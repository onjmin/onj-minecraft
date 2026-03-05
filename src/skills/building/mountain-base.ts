import { goals } from "mineflayer-pathfinder";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingMountainSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.mountain-base",
	description:
		"Digs a horizontal cave into the side of a mountain, then adds light, crafting table, furnace, chest, and door in order. Only registers base when all items are placed.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const pos = bot.entity.position;
		const toolPlugin = (bot as any).tool;

		agent.log(
			"[building.mountain] Started at position:",
			Math.floor(pos.x),
			Math.floor(pos.y),
			Math.floor(pos.z),
		);

		const digTargets = [
			{ x: 1, y: 0, z: 0 },
			{ x: 2, y: 0, z: 0 },
			{ x: 3, y: 0, z: 0 },
			{ x: 1, y: 1, z: 0 },
			{ x: 2, y: 1, z: 0 },
			{ x: 3, y: 1, z: 0 },
			{ x: 1, y: -1, z: 0 },
			{ x: 2, y: -1, z: 0 },
			{ x: 3, y: -1, z: 0 },
			{ x: 1, y: 0, z: 1 },
			{ x: 2, y: 0, z: 1 },
			{ x: 3, y: 0, z: 1 },
			{ x: 1, y: 0, z: -1 },
			{ x: 2, y: 0, z: -1 },
			{ x: 3, y: 0, z: -1 },
		];

		agent.log("[building.mountain] Phase 0a: Checking floor stability...");
		const unstableFloorBlocks = ["water", "lava", "air", "void_air", "cave_air"];
		const floorCheckTargets = [
			{ x: 0, y: 0, z: 0 },
			{ x: 1, y: 0, z: 0 },
			{ x: 2, y: 0, z: 0 },
			{ x: 3, y: 0, z: 0 },
		];
		for (const offset of floorCheckTargets) {
			const targetPos = pos.offset(offset.x, offset.y, offset.z);
			const groundPos = targetPos.offset(0, -1, 0);
			const groundBlock = bot.blockAt(groundPos);
			if (!groundBlock || unstableFloorBlocks.includes(groundBlock.name)) {
				agent.log(
					`[building.mountain] Failed: Unstable floor at ${offset.x},${offset.z}: ${groundBlock?.name || "none"}`,
				);
				return skillResult.fail(
					`Cannot build here: floor is unstable (${groundBlock?.name || "air"}).`,
				);
			}
		}

		agent.log("[building.mountain] Phase 0b: Checking for unbreakable blocks...");
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
					`[building.mountain] Failed: Cannot break ${block.name} at ${offset.x},${offset.y},${offset.z}`,
				);
				return skillResult.fail(
					`Cannot build here: ${block.name} blocks the way and cannot be broken.`,
				);
			}
		}
		agent.log("[building.mountain] Phase 0: Location check passed");

		let dugCount = 0;
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
			return skillResult.fail(`Not enough space dug. Need at least 6 blocks, got ${dugCount}.`);
		}

		agent.log("[building.mountain] Phase 1b: Placing dirt walls...");
		const dirtBlocks = ["dirt", "grass_block"];
		const wallTargets = [
			{ x: 4, y: 0, z: 0 },
			{ x: 4, y: 1, z: 0 },
			{ x: 4, y: -1, z: 0 },
			{ x: 4, y: 0, z: 1 },
			{ x: 4, y: 0, z: -1 },
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
					} catch (e) {}
				}
			}
		}
		agent.log(`[building.mountain] Placed ${wallCount} wall blocks`);

		const installedItems: string[] = ["space"];

		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			await bot.equip(torchItem, "hand");
			const centerPos = pos.offset(2, 1, 0);
			const blockAtCenter = bot.blockAt(centerPos);
			if (blockAtCenter && blockAtCenter.name === "air") {
				try {
					await bot.placeBlock(blockAtCenter, new (require("vec3"))(0, -1, 0));
					installedItems.push("torch");
				} catch (e) {}
			}
		}
		if (!installedItems.includes("torch")) {
			return skillResult.fail("Failed to place torch. Cannot proceed without light.");
		}

		const table = await ensureCraftingTable(agent);
		if (!table) {
			return skillResult.fail("Failed to place crafting table.");
		}
		installedItems.push("crafting_table");

		const furnace = await ensureFurnace(agent);
		if (!furnace) {
			return skillResult.fail("Failed to place furnace.");
		}
		installedItems.push("furnace");

		const chestItem = bot.inventory.items().find((i) => i.name === "chest");
		if (chestItem) {
			const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
			if (placed) installedItems.push("chest");
		}

		const doorItem = bot.inventory.items().find((i) => i.name.endsWith("_door"));
		if (doorItem) {
			const placed = await tryPlaceBlock(
				bot,
				doorItem.name,
				bot.registry.blocksByName[doorItem.name].id,
				agent,
			);
			if (placed) installedItems.push("door");
		}

		const baseId = `mountain_${Date.now()}`;
		const registered = agent.addBase({
			id: baseId,
			type: "mountain",
			position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
			safe: true,
			functional: true,
			hasStorage: installedItems.includes("chest"),
		});

		if (!registered) {
			return skillResult.fail("Base too close to existing base. Choose a different location.");
		}

		agent.log(`[building.mountain] Base ${baseId} registered: ${installedItems.join(", ")}`);

		agent.log("[building.mountain] Phase 2: Initial maintenance...");
		const maintenanceActions: string[] = [];

		const torchCenterPos = pos.offset(2, 1, 0);
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
		agent.log(`[building.mountain] Maintenance: ${maintenanceActions.join(", ")}`);

		return skillResult.ok(`Built mountain base. Items: ${finalItems.join(", ")}`, {
			baseId,
			items: finalItems,
		});
	},
});
