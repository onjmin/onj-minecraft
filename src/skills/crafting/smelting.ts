import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";
import { ensureFurnace } from "./util";

/**
 * Smelting Domain: Processing raw materials.
 * 精錬ドメイン：原料の加工。
 * かまどを確保し、レシピデータに基づいて焼けるアイテムと燃料を自動選別して投入します。
 */
export const craftSmeltingTool = createTool<void, { item: string; amount: number }>({
	name: "crafting.smelting",
	description:
		"Automatically identifies smeltable items and fuels using recipe data, and starts the smelting process.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ item: string; amount: number }>> => {
		const { bot } = agent;

		// 1. かまどの確保（util.ts の共通関数を使用）
		const furnaceBlock = await ensureFurnace(bot);
		if (!furnaceBlock) {
			return toolResult.fail(
				"Could not secure a furnace. Cobblestone (8) and a crafting table are required.",
			);
		}

		const items = bot.inventory.items();

		// 2. 精錬対象（Input）の厳密な判定
		// かまどのレシピデータにそのアイテムが材料として含まれているかを確認
		const smeltable = items.find((item) => {
			const recipes = bot.recipesAll(item.type, null, furnaceBlock);
			return recipes.length > 0;
		});

		if (!smeltable) {
			return toolResult.fail("No items in inventory can be smelted in a furnace.");
		}

		// 3. 燃料（Fuel）の厳密な判定
		// レジストリの燃焼時間(fuelDuration)データがある、または伝統的な燃料アイテム
		const fuel = items.find((item) => {
			const name = item.name;
			return (
				["coal", "charcoal", "coal_block", "lava_bucket", "blaze_rod"].includes(name) ||
				name.endsWith("_planks") ||
				name.endsWith("_log") ||
				name.endsWith("_wood") ||
				name.endsWith("_stem") ||
				["stick", "crafting_table", "chest", "barrel", "ladder", "bowl"].includes(name)
			);
		});

		if (!fuel) {
			return toolResult.fail("No suitable fuel found in inventory.");
		}

		try {
			// 4. かまどを開いて投入
			const furnace = await bot.openFurnace(furnaceBlock);

			// 燃料を投入（最大スタック、または現在必要な分だけ）
			await furnace.putFuel(fuel.type, null, fuel.count);

			// 素材を投入
			await furnace.putInput(smeltable.type, null, smeltable.count);

			furnace.close();

			return toolResult.ok(
				`Started smelting ${smeltable.count}x ${smeltable.name} using ${fuel.name}.`,
				{
					item: smeltable.name,
					amount: smeltable.count,
				},
			);
		} catch (err) {
			return toolResult.fail(
				`Smelting action failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
