import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureCraftingTable, ensurePlanks, tryPlaceBlock } from "./util";

/**
 * Crafting Domain: Chest management.
 * クラフトドメイン：収納管理。
 * 材料がある限り、反復してチェストを作成します。
 */
export const craftChestSkill = createSkill<void, { item: string; count: number }>({
	name: "crafting.chest",
	description: "Crafts 1 chest from planks. Can be repeated to build up chest.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ item: string; count: number }>> => {
		const { bot } = agent;

		// すでにチェストがあるかチェック
		const existingChest = bot.inventory.items().find((i) => i.name === "chest");
		if (existingChest) {
			agent.log(`[craftChest] Found existing chest in inventory, attempting to place...`);
			const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
			if (placed) {
				return skillResult.ok("Placed existing chest.", { item: "chest", count: 1 });
			}
			agent.log(`[craftChest] Could not place existing chest`);
		}

		// 板材を事前に確保（チェストは8板材必要）
		const planksReady = await ensurePlanks(agent, 8);
		if (!planksReady) {
			return skillResult.fail("Insufficient materials: Need planks (or logs) to craft chest.");
		}

		// 1. 作業台の確保（共通関数を利用）
		const table = await ensureCraftingTable(agent);
		if (!table) {
			return skillResult.fail("Could not secure a crafting table for chest crafting.");
		}

		try {
			// 2. レシピの確認
			const chestItemRef = bot.registry.itemsByName.chest;
			agent.log(`[craftChest] Searching for chest recipe, itemId=${chestItemRef.id}`);

			// recipesFor を使い、材料をチェック
			const recipes = bot.recipesFor(chestItemRef.id, null, 1, table);
			agent.log(`[craftChest] Found ${recipes.length} chest recipes`);

			if (!recipes || recipes.length === 0) {
				const planks = bot.inventory.items().filter((i) => i.name.endsWith("planks"));
				agent.log(
					`[craftChest] Planks in inventory: ${planks.map((p) => `${p.name}:${p.count}`).join(", ")}`,
				);

				return skillResult.fail("Recipe not found. Ensure you have 8 planks of the same type.");
			}

			// 3. クラフト実行
			await bot.craft(recipes[0], 1, table);
			agent.log(`[craftChest] Crafted chest, now placing...`);

			// 4. チェストを設置
			const chestItem = bot.inventory.items().find((i) => i.name === "chest");
			agent.log(`[craftChest] Chest item in inventory: found=${!!chestItem}`);
			if (chestItem) {
				const placed = await tryPlaceBlock(bot, "chest", bot.registry.blocksByName.chest.id, agent);
				if (placed) {
					agent.log(`[craftChest] SUCCESS: Placed chest at ${placed.position}`);
					return skillResult.ok("Crafted and placed 1 chest.", {
						item: "chest",
						count: 1,
					});
				}
			}

			agent.log(`[craftChest] SUCCESS: Crafted chest (not placed)`);
			return skillResult.ok("Crafted 1 chest.", {
				item: "chest",
				count: 1,
			});
		} catch (err) {
			return skillResult.fail(
				`Chest crafting failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
