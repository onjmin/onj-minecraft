import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";

/**
 * Maintenance Domain: Essential survival behaviors.
 * 維持ドメイン：生存に不可欠な行動（食事など）を管理します。
 */
export const eatFoodTool = createTool<void, { ate: boolean; foodLevel: number }>({
	name: "maintenance.eat",
	description: "Automatically selects and eats food from inventory when hunger is low.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ ate: boolean; foodLevel: number }>> => {
		const { bot } = agent;

		// Check if actually hungry (Max food is 20)
		// 空腹度を確認（20が最大）。16以下なら食べる準備。
		if (bot.food >= 20) {
			return toolResult.ok("Not hungry right now.", { ate: false, foodLevel: bot.food });
		}

		// Find edible items
		// インベントリから食べ物を探す
		const mcData = require("minecraft-data")(bot.version);
		const edibleItems = bot.inventory.items().filter((item) => {
			const foodStats = mcData.foodsArray.find((f: any) => f.name === item.name);
			return !!foodStats;
		});

		if (edibleItems.length === 0) {
			return toolResult.fail("No food found in inventory! Need to hunt or farm.");
		}

		try {
			// Pick the first food item and eat
			// 最初の食べ物を選んで食べる
			const food = edibleItems[0];
			await bot.equip(food, "hand");
			await bot.consume();

			return toolResult.ok(`Ate ${food.name}. Current food level: ${bot.food}`, {
				ate: true,
				foodLevel: bot.food,
			});
		} catch (err) {
			return toolResult.fail(
				"Failed to eat: " + (err instanceof Error ? err.message : String(err)),
			);
		}
	},
});
