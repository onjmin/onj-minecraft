import type { Bot } from "mineflayer";
import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";
import { ensureCraftingTable, ensureSticks } from "./util";

/**
 * Crafting Domain: Equipment maintenance.
 * クラフトドメイン：装備の維持管理。持っている素材から最適なツールを1つ作成します。
 */
export const craftToolTool = createTool<void, { item: string; material: string }>({
	name: "crafting.tool",
	description:
		"Checks inventory and crafts the best possible tool (pickaxe, axe, shovel, or hoe) that is missing or needs an upgrade.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ item: string; material: string }>> => {
		const { bot } = agent;

		// 【ここに追加】ツールの材料を確定させる前に、まず棒を確保する
		// ツール作成には最低2本必要なので、確保を試みる
		const sticksReady = await ensureSticks(bot, 2);
		if (!sticksReady) {
			// 棒が作れなかった（板材も原木もない）場合は、エラーではなく
			// 「素材不足」として失敗させることで、LLMに伐採などを促す
			return toolResult.fail(
				"Insufficient materials: Need sticks (or wood to make them) to craft tools.",
			);
		}

		// 1. 次に作るべきツールと素材を判定
		const target = craftingManager.determineNextTool(bot);

		if (!target) {
			return toolResult.fail(
				"No tools to craft. Already have the best possible equipment with current materials.",
			);
		}

		const itemName = `${target.material}_${target.toolType}`;

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent.bot);

			if (!craftingTable) {
				return toolResult.fail(
					"Crafting table is not nearby. Please place one to proceed with maintenance.",
				);
			}

			// 3. レシピの取得とクラフト
			const item = bot.registry.itemsByName[itemName];
			const recipes = bot.recipesFor(item.id, null, 1, craftingTable);

			if (recipes.length === 0) {
				return toolResult.fail(`Insufficient materials or no recipe for ${itemName}.`);
			}

			await bot.craft(recipes[0], 1, craftingTable);

			return toolResult.ok(`Upgraded equipment: Crafted 1 ${itemName}.`, {
				item: target.toolType,
				material: target.material,
			});
		} catch (err) {
			return toolResult.fail(
				`Crafting interrupted: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

/**
 * Specialized manager for crafting decisions
 * クラフトの意思決定を管理するマネージャー
 */
export const craftingManager = {
	// 優先順位: ダイヤモンド > 鉄 > 金 > 石 > 木
	materials: ["diamond", "iron", "gold", "stone", "wooden"],
	// 優先順位: ピッケル > オノ > シャベル > クワ
	types: ["pickaxe", "axe", "shovel", "hoe"],

	determineNextTool: (bot: Bot): { toolType: string; material: string } | null => {
		const items = bot.inventory.items();

		for (const type of craftingManager.types) {
			// 現在そのカテゴリで持っている最高の素材を特定
			let currentBestIdx = 999;
			for (const item of items) {
				if (item.name.endsWith(`_${type}`)) {
					const mat = item.name.split("_")[0];
					const idx = craftingManager.materials.indexOf(mat);
					if (idx !== -1 && idx < currentBestIdx) currentBestIdx = idx;
				}
			}

			// 作成可能な最高の素材をチェック
			for (let i = 0; i < craftingManager.materials.length; i++) {
				const mat = craftingManager.materials[i];

				// 既に同等以上のものを持っていればこのツール種別はパス
				if (i >= currentBestIdx) break;

				// 素材アイテム名への変換（木だけ例外）
				const resourceName =
					mat === "wooden" ? "oak_planks" : mat === "stone" ? "cobblestone" : `${mat}_ingot`;
				const resource = items.find((it) => it.name === resourceName || it.name === mat);

				// 素材が足りているか（ツール作成には最低3個あればどのツールも作れる想定）
				if (resource && resource.count >= 3) {
					return { toolType: type, material: mat };
				}
			}
		}
		return null;
	},
};
