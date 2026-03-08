import type { MinecraftAgent } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureCraftingTable, ensurePlanks, ensureSticks } from "./util";

/**
 * Crafting Domain: Weapon and Armor maintenance.
 * クラフトドメイン：武器防具の維持管理。
 * 剣、盾、防具一式のうち、最もアップグレードが必要なものを1つ作成します。
 */
export const craftWeaponSkill = createSkill<void, { item: string; material: string }>({
	name: "crafting.weapon",
	description:
		"Automatically crafts the best weapon or armor (Sword > Shield > Armor) you don't have yet.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ item: string; material: string }>> => {
		const { bot } = agent;

		// 棒を確保（武器作成には最低2本必要）
		const sticksReady = await ensureSticks(agent, 2);
		if (!sticksReady) {
			// 棒が作れなかった（板材も原木もない）場合は、エラーではなく
			// 「素材不足」として失敗させることで、LLMに伐採などを促す
			return skillResult.fail(
				"Insufficient materials: Need sticks (or wood to make them) to craft skills.",
			);
		}

		// 板材を事前に確保（木武器の場合は2枚以上必要）
		await ensurePlanks(agent, 2);

		// 1. 次に作るべき装備を判定
		const target = craftingManager.determineNextWeapon(agent);
		if (!target) {
			return skillResult.fail("All combat equipment is already at the highest possible quality.");
		}

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent);

			// (作業台の設置・作成ロジックは craftSkillSkill と同様なので、実際には共通関数化を推奨)
			if (!craftingTable)
				return skillResult.fail("Crafting table is required for weapon maintenance.");

			// 3. 装備のクラフト
			const itemName =
				target.skillType === "shield" ? "shield" : `${target.material}_${target.skillType}`;
			const item = bot.registry.itemsByName[itemName];
			const recipes = bot.recipesFor(item.id, null, 1, craftingTable);

			if (recipes.length === 0) {
				return skillResult.fail(`Insufficient materials for ${itemName}.`);
			}

			await bot.craft(recipes[0], 1, craftingTable);

			return skillResult.ok(`Battle readiness improved: Crafted 1 ${itemName}.`, {
				item: target.skillType,
				material: target.material,
			});
		} catch (err) {
			return skillResult.fail(
				`Weapon crafting failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

// craftingManager に武器用ロジックを追加
export const craftingManager = {
	materials: ["diamond", "iron", "gold", "stone", "wooden"],
	weaponTypes: ["sword", "shield", "helmet", "chestplate", "leggings", "boots"],

	determineNextWeapon: (agent: MinecraftAgent): { skillType: string; material: string } | null => {
		const { bot } = agent;
		const items = bot.inventory.items();

		for (const type of craftingManager.weaponTypes) {
			// 盾は素材の概念が特殊（基本木+鉄）なので個別処理
			if (type === "shield") {
				const hasShield = items.some((it) => it.name === "shield");
				const iron = items.find((it) => it.name === "iron_ingot");
				const planks = items.find((it) => it.name.endsWith("_planks"));
				if (!hasShield && iron && planks && planks.count >= 1) {
					return { skillType: "shield", material: "iron" };
				}
				// 原木からも作れる
				const logs = items.find(
					(it) =>
						it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
				);
				if (!hasShield && iron && logs) {
					return { skillType: "shield", material: "iron" };
				}
				continue;
			}

			// 防具・剣のアップグレード判定
			let currentBestIdx = 999;
			for (const item of items) {
				if (item.name.endsWith(`_${type}`)) {
					const mat = item.name.split("_")[0];
					const idx = craftingManager.materials.indexOf(mat);
					if (idx !== -1 && idx < currentBestIdx) currentBestIdx = idx;
				}
			}

			for (let i = 0; i < craftingManager.materials.length; i++) {
				const mat = craftingManager.materials[i];
				// currentBestIdx=999 は「持っていない」→スキップしない
				if (currentBestIdx !== 999 && i >= currentBestIdx) continue;

				// 金の防具は基本作らないようにスキップ（金ツールは作る場合があるが防具は効率が悪いため）
				if (mat === "gold") continue;

				if (mat === "wooden") {
					// 木素材: 板材または原木
					const planks = items.find((it) => it.name.endsWith("_planks"));
					const logs = items.find(
						(it) =>
							it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
					);
					if (planks || logs) {
						return { skillType: type, material: mat };
					}
				} else if (mat === "stone") {
					const resourceName = "cobblestone";
					const resource = items.find((it) => it.name === resourceName);
					const REQUIRED = { sword: 2, helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
					if (resource && resource.count >= (REQUIRED as any)[type]) {
						return { skillType: type, material: mat };
					}
				} else {
					const resourceName = `${mat}_ingot`;
					const resource = items.find((it) => it.name === resourceName);
					const REQUIRED = { sword: 2, helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
					if (resource && resource.count >= (REQUIRED as any)[type]) {
						return { skillType: type, material: mat };
					}
				}
			}
		}
		return null;
	},
};
