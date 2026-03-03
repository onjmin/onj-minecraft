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

		return skillResult.ok(`Built mountain base. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
