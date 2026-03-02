import type { Bot } from "mineflayer";
import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureCraftingTable, ensurePlanks, ensureSticks } from "./util";

/**
 * Crafting Domain: Equipment maintenance.
 * クラフトドメイン：装備の維持管理。持っている素材から最適なツールを1つ作成します。
 */
export const craftToolSkill = createSkill<void, { item: string; material: string }>({
	name: "crafting.tool",
	description:
		"Checks inventory and crafts the best possible tool (pickaxe, axe, shovel, or hoe) that is missing or needs an upgrade.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ item: string; material: string }>> => {
		const { bot } = agent;

		agent.log(`[craftTool] Starting tool crafting...`);

		// 棒を確保（ツール作成には最低2本必要）
		const sticksReady = await ensureSticks(agent, 2);
		agent.log(`[craftTool] Sticks ready: ${sticksReady}`);
		if (!sticksReady) {
			// 棒が作れなかった（板材も原木もない）場合は、エラーではなく
			// 「素材不足」として失敗させることで、LLMに伐採などを促す
			return skillResult.fail(
				"Insufficient materials: Need sticks (or wood to make them) to craft tools.",
			);
		}
		
		// 板材を事前に確保（木ツールの場合は3枚必要）
		await ensurePlanks(agent, 3);

		// 1. 次に作るべきツールと素材を判定
		const target = craftingManager.determineNextSkill(bot);
		agent.log(
			`[craftTool] Target tool: ${target ? `${target.material}_${target.skillType}` : "none"}`,
		);

		if (!target) {
			return skillResult.fail(
				"No tools to craft. Already have the best possible equipment with current materials.",
			);
		}

		const itemName = `${target.material}_${target.skillType}`;

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent);
			agent.log(`[craftTool] Crafting table: ${craftingTable ? "found" : "not found"}`);

			if (!craftingTable) {
				return skillResult.fail(
					"Crafting table is not nearby. Please place one to proceed with maintenance.",
				);
			}

			// 3. レシピの取得とクラフト
			const item = bot.registry.itemsByName[itemName];
			const recipes = bot.recipesFor(item.id, null, 1, craftingTable);
			agent.log(`[craftTool] Found ${recipes.length} recipes for ${itemName}`);

			if (recipes.length === 0) {
				return skillResult.fail(`Insufficient materials or no recipe for ${itemName}.`);
			}

			await bot.craft(recipes[0], 1, craftingTable);
			agent.log(`[craftTool] SUCCESS: Crafted ${itemName}`);

			return skillResult.ok(`Upgraded equipment: Crafted 1 ${itemName}.`, {
				item: target.skillType,
				material: target.material,
			});
		} catch (err) {
			return skillResult.fail(
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

	determineNextSkill: (bot: Bot): { skillType: string; material: string } | null => {
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

				// 既に同等以上の素材を持っていればスキップ
				// currentBestIdx=999 は「持っていない」→スキップしない
				if (currentBestIdx !== 999 && i >= currentBestIdx) {
					continue;
				}

				let requiredCount: number;

				if (mat === "wooden") {
					// 木ツール: 板材4つ以上、または原木1つ以上（板材に変換可能）
					requiredCount = 4;
					// インベントリにある任意の板材をチェック
					const planks = items.find((it) => it.name.endsWith("_planks") && it.count >= 4);
					const logs = items.find(
						(it) =>
							it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
					);
					if (planks) {
						return { skillType: type, material: mat };
					} else if (logs && logs.count >= 1) {
						return { skillType: type, material: mat };
					}
				} else if (mat === "stone") {
					requiredCount = 3;
					const resourceName = "cobblestone";
					const resource = items.find((it) => it.name === resourceName || it.name === mat);
					if (resource && resource.count >= requiredCount) {
						return { skillType: type, material: mat };
					}
				} else {
					requiredCount = 3;
					const resourceName = `${mat}_ingot`;
					const resource = items.find((it) => it.name === resourceName || it.name === mat);
					if (resource && resource.count >= requiredCount) {
						return { skillType: type, material: mat };
					}
				}
			}
		}
		return null;
	},
};
