import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureFurnace } from "./util";

/**
 * Smelting Domain: Processing raw materials.
 * 精錬ドメイン：原料の加工。
 * かまどを確保し、レシピデータに基づいて焼けるアイテムと燃料を自動選別して投入します。
 */
export const craftSmeltingSkill = createSkill<void, { item: string; amount: number }>({
	name: "crafting.smelting",
	description:
		"Automatically identifies smeltable items and fuels using recipe data, and starts the smelting process. Also supports creating charcoal (from wood/logs) for crafting torches.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ item: string; amount: number }>> => {
		const { driver } = agent;

		// 1. かまどの確保（util.ts の共通関数を使用）
		const furnaceBlock = await ensureFurnace(agent);
		if (!furnaceBlock) {
			return skillResult.fail(
				"Could not secure a furnace. Cobblestone (8) and a crafting table are required.",
			);
		}

		const items = driver.inventory.items();

		// 2. 精錬対象（Input）の厳密な判定
		// かまどのレシピデータにそのアイテムが材料として含まれているかを確認
		const smeltable = items.find((item) => driver.canSmelt(item.name));

		if (!smeltable) {
			return skillResult.fail("No items in inventory can be smelted in a furnace.");
		}

		// 3. 燃料（Fuel）の厳密な判定
		// レジストリの燃焼時間(fuelDuration)データがある、または伝統的な燃料アイテム
		const fuel = items.find((item) => {
			const name = item.name;
			return (
				["coal", "charcoal", "coal_block", "lava_bucket", "blaze_rod", "dead_bush"].includes(
					name,
				) ||
				name.endsWith("_planks") ||
				name.endsWith("_log") ||
				name.endsWith("_wood") ||
				name.endsWith("_stem") ||
				["stick", "crafting_table", "chest", "barrel", "ladder", "bowl"].includes(name)
			);
		});

		if (!fuel) {
			return skillResult.fail("No suitable fuel found in inventory.");
		}

		try {
			// 4. かまどを開いて投入（燃料は最大スタック、素材は手持ちすべて）
			await driver.smelt(
				furnaceBlock.position,
				smeltable.name,
				smeltable.count,
				fuel.name,
				fuel.count,
			);

			return skillResult.ok(
				`Started smelting ${smeltable.count}x ${smeltable.name} using ${fuel.name}.`,
				{
					item: smeltable.name,
					amount: smeltable.count,
				},
			);
		} catch (err) {
			return skillResult.fail(
				`Smelting action failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
