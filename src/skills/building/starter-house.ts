import { goals } from "mineflayer-pathfinder";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingHouseSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.starter-house",
	description:
		"Builds a wooden box structure on the ground as a starter house. Places light, crafting table, furnace, chest, and door. Requires wood/planks.",
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

		for (const offset of wallTargets) {
			if (agent.checkAbort(signal)) break;

			const targetPos = pos.offset(offset.x, 0, offset.z);
			const block = bot.blockAt(targetPos);

			if (block && block.name === "air") {
				const wood = bot.inventory.items().find((i) => woodBlocks.includes(i.name));
				const plank = bot.inventory.items().find((i) => plankBlocks.includes(i.name));

				const itemToPlace = plank || wood;
				if (itemToPlace) {
					const blockId =
						bot.registry.blocksByName[
							itemToPlace.name === "oak_log"
								? "oak_planks"
								: itemToPlace.name.replace("_log", "_planks")
						];
					if (blockId) {
						await bot.equip(itemToPlace, "hand");
						try {
							await bot.placeBlock(targetPos, new (require("vec3"))(0, 1, 0));
						} catch (e) {}
					}
				}
			}
		}

		const installedItems: string[] = [];

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

		const table = await ensureCraftingTable(agent);
		if (table) installedItems.push("crafting_table");

		const furnace = await ensureFurnace(agent);
		if (furnace) installedItems.push("furnace");

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
		agent.addBase({
			id: baseId,
			type: "starter-house",
			position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
			safe: true,
			functional: installedItems.includes("crafting_table") && installedItems.includes("furnace"),
			hasStorage: installedItems.includes("chest"),
		});
		agent.log(`[building.house] Base ${baseId}: ${installedItems.join(", ")}`);

		return skillResult.ok(`Built starter house. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
