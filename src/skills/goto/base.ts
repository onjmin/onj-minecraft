import { goals } from "mineflayer-pathfinder";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const gotoBaseSkill = createSkill<void, { baseId: string; reason: string }>({
	name: "goto.base",
	description:
		"Returns to the nearest registered base. Prioritizes: safe base at night, storage base when inventory full, functional base when smelting possible. Uses straight-line distance.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ baseId: string; reason: string }>> => {
		const { bot } = agent;
		const bases = agent.getBases();

		if (bases.length === 0) {
			return skillResult.fail("No registered bases found.");
		}

		const timeOfDay = bot.time.timeOfDay;
		const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
		const isFullInventory = bot.inventory.slots.filter((s) => s !== null).length >= 36;

		const hasFuel = bot.inventory
			.items()
			.some(
				(i) => i.name === "coal" || i.name === "charcoal" || i.name === "wood" || i.name === "log",
			);
		const hasOre = bot.inventory
			.items()
			.some(
				(i) =>
					i.name.includes("ore") ||
					i.name.includes("raw_iron") ||
					i.name.includes("raw_gold") ||
					i.name.includes("copper_ore"),
			);
		const canSmelt = hasFuel && hasOre;

		let targetBase = null;
		let reason = "";

		if (canSmelt) {
			const functionalBases = bases.filter((b) => b.functional);
			if (functionalBases.length > 0) {
				targetBase = functionalBases[0];
				reason = "smelting";
			}
		}

		if (!targetBase && isFullInventory) {
			const storageBases = bases.filter((b) => b.hasStorage);
			if (storageBases.length > 0) {
				const pos = bot.entity.position;
				storageBases.sort(
					(a, b) =>
						Math.abs(a.position.x - pos.x) +
						Math.abs(a.position.z - pos.z) -
						(Math.abs(b.position.x - pos.x) + Math.abs(b.position.z - pos.z)),
				);
				targetBase = storageBases[0];
				reason = "inventory_full";
			}
		}

		if (!targetBase && isNight) {
			const safeBases = bases.filter((b) => b.safe);
			if (safeBases.length > 0) {
				const pos = bot.entity.position;
				safeBases.sort(
					(a, b) =>
						Math.abs(a.position.x - pos.x) +
						Math.abs(a.position.z - pos.z) -
						(Math.abs(b.position.x - pos.x) + Math.abs(b.position.z - pos.z)),
				);
				targetBase = safeBases[0];
				reason = "night";
			}
		}

		if (!targetBase) {
			const pos = bot.entity.position;
			const sorted = [...bases].sort(
				(a, b) =>
					Math.abs(a.position.x - pos.x) +
					Math.abs(a.position.z - pos.z) -
					(Math.abs(b.position.x - pos.x) + Math.abs(b.position.z - pos.z)),
			);
			targetBase = sorted[0];
			reason = "nearest";
		}

		agent.log(
			`[goto.base] Target: ${targetBase.id} at (${targetBase.position.x}, ${targetBase.position.y}, ${targetBase.position.z}), reason: ${reason}`,
		);

		try {
			const goal = new goals.GoalNear(
				targetBase.position.x,
				targetBase.position.y,
				targetBase.position.z,
				2,
			);
			await agent.abortableGoto(signal, goal);
			return skillResult.ok(`Returned to base ${targetBase.id}. Reason: ${reason}`, {
				baseId: targetBase.id,
				reason,
			});
		} catch (err) {
			return skillResult.fail(
				`Failed to reach base: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
