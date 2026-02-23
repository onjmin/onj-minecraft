import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";
import { ensureCraftingTable } from "./util";

/**
 * Crafting Domain: Storage management.
 * クラフトドメイン：収納管理。
 * 材料がある限り、反復してチェストを作成します。
 */
export const craftStorageTool = createTool<void, { item: string; count: number }>({
	name: "crafting.storage",
	description: "Crafts 1 chest from planks. Can be repeated to build up storage.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ item: string; count: number }>> => {
		const { bot } = agent;

		// 1. 作業台の確保（共通関数を利用）
		const table = await ensureCraftingTable(bot);
		if (!table) {
			return toolResult.fail("Could not secure a crafting table for storage crafting.");
		}

		try {
			// 2. レシピの確認
			const chestItem = bot.registry.itemsByName.chest;
			const recipes = bot.recipesFor(chestItem.id, null, 1, table);

			if (recipes.length === 0) {
				return toolResult.fail("Insufficient planks to craft a chest (8 planks required).");
			}

			// 3. クラフト実行（1ターン1個の原則）
			await bot.craft(recipes[0], 1, table);

			return toolResult.ok("Crafted 1 chest.", {
				item: "chest",
				count: 1,
			});
		} catch (err) {
			return toolResult.fail(
				`Storage crafting failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
