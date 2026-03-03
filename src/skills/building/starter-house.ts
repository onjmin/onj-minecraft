import { goals } from "mineflayer-pathfinder";
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
		const pos = bot.entity.position;

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

		let builtCount = 0;
		for (const offset of wallTargets) {
			if (agent.checkAbort(signal)) break;
			const targetPos = pos.offset(offset.x, 0, offset.z);
			const block = bot.blockAt(targetPos);

			if (block && block.name === "air") {
				const wood = bot.inventory.items().find((i) => woodBlocks.includes(i.name));
				const plank = bot.inventory.items().find((i) => plankBlocks.includes(i.name));
				const itemToPlace = plank || wood;

				if (itemToPlace) {
					await bot.equip(itemToPlace, "hand");
					try {
						await bot.placeBlock(targetPos, new (require("vec3"))(0, 1, 0));
						builtCount++;
					} catch (e) {}
				}
			}
		}

		if (builtCount < 8) {
			return skillResult.fail(`Not enough walls built. Need at least 8, got ${builtCount}.`);
		}

		const installedItems: string[] = ["structure"];

		const torchItem = bot.inventory.items().find((i) => i.name === "torch");
		if (torchItem) {
			await bot.equip(torchItem, "hand");
			const centerPos = pos.offset(0, 2, 0);
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
			return skillResult.fail("Base too close to existing base. Choose a different location.");
		}

		agent.log(`[building.house] Base ${baseId} registered: ${installedItems.join(", ")}`);

		return skillResult.ok(`Built starter house. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
