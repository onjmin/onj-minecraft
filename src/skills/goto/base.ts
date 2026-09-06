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
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const bases = agent.getBases();

		if (bases.length === 0) {
			return skillResult.fail("No registered bases found.");
		}

		const timeOfDay = state.timeOfDay;
		const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
		const isFullInventory = driver.inventory.emptySlotCount() === 0;

		const items = driver.inventory.items();
		const hasFuel = items.some(
			(i) => i.name === "coal" || i.name === "charcoal" || i.name === "wood" || i.name === "log",
		);
		const hasOre = items.some(
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
				const pos = state.position;
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
				const pos = state.position;
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
			const pos = state.position;
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
			await agent.driver.goto(signal, {
				kind: "near",
				position: targetBase.position,
				distance: 2,
			});
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
