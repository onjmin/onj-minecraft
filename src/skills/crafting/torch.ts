import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureSticks } from "./util";

/**
 * Crafting Domain: Torch management.
 * クラフトドメイン：照明管理。
 * 材料からトーチを作成します。
 */
export const craftTorchSkill = createSkill<void, { count: number }>({
	name: "crafting.torch",
	description:
		"Crafts torches from coal/charcoal and sticks. Requires sticks and coal or charcoal.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ count: number }>> => {
		const { driver } = agent;

		const sticksReady = await ensureSticks(agent, 1);
		if (!sticksReady) {
			return skillResult.fail("Insufficient materials: Need sticks to craft torches.");
		}

		const coal = driver.inventory.items().find((i) => i.name === "coal");
		const charcoal = driver.inventory.items().find((i) => i.name === "charcoal");
		const fuel = coal || charcoal;

		if (!fuel) {
			return skillResult.fail("Insufficient materials: Need coal or charcoal to craft torches.");
		}

		const fuelName = fuel.name;
		agent.log(`[craftTorch] Fuel found: ${fuelName}, count=${fuel.count}`);

		if (!driver.canCraft("torch")) {
			agent.log(`[craftTorch] No torch recipe found`);
			return skillResult.fail("No torch recipe available.");
		}

		try {
			await driver.craft("torch", Math.min(4, fuel.count));
			const torches = driver.inventory.items().find((i) => i.name === "torch");
			agent.log(`[craftTorch] Crafted torches: count=${torches?.count || 0}`);

			return skillResult.ok(`Crafted torches.`, {
				count: torches?.count || 4,
			});
		} catch (err) {
			return skillResult.fail(
				`Torch crafting failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
