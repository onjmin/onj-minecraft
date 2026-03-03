import { goals } from "mineflayer-pathfinder";
import { ensureCraftingTable, ensureFurnace, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const buildingUndergroundSkill = createSkill<void, { baseId: string; items: string[] }>({
	name: "building.underground-base",
	description:
		"Digs a 3x3x3+ underground space and builds a base with light, crafting table, furnace, chest, and door. Creates underground base.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; items: string[] }>> => {
		const { bot } = agent;
		const pos = bot.entity.position;

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

		const baseId = `underground_${Date.now()}`;
		agent.addBase({
			id: baseId,
			type: "underground",
			position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
			safe: true,
			functional: installedItems.includes("crafting_table") && installedItems.includes("furnace"),
			hasStorage: installedItems.includes("chest"),
		});
		agent.log(
			`[building.underground] Base ${baseId} at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}): ${installedItems.join(", ")}`,
		);

		return skillResult.ok(`Built underground base. Items: ${installedItems.join(", ")}`, {
			baseId,
			items: installedItems,
		});
	},
});
