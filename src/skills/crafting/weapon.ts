import type { Bot } from "mineflayer";
import type { AgentOrchestrator } from "../../core/agent";
import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureCraftingTable, ensureSticks } from "./util";

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
	handler: async (
		agent: AgentOrchestrator,
	): Promise<SkillResponse<{ item: string; material: string }>> => {
		const { bot } = agent;

		// 【ここに追加】ツールの材料を確定させる前に、まず棒を確保する
		// ツール作成には最低2本必要なので、確保を試みる
		const sticksReady = await ensureSticks(bot, 2);
		if (!sticksReady) {
			// 棒が作れなかった（板材も原木もない）場合は、エラーではなく
			// 「素材不足」として失敗させることで、LLMに伐採などを促す
			return skillResult.fail(
				"Insufficient materials: Need sticks (or wood to make them) to craft skills.",
			);
		}

		// 1. 次に作るべき装備を判定
		const target = craftingManager.determineNextWeapon(bot);
		if (!target) {
			return skillResult.fail("All combat equipment is already at the highest possible quality.");
		}

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent.bot);

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

	determineNextWeapon: (bot: Bot): { skillType: string; material: string } | null => {
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
				if (i >= currentBestIdx) break;

				// 金の防具は基本作らないようにスキップ（金ツールは作る場合があるが防具は効率が悪いため）
				if (mat === "gold") continue;

				const resourceName =
					mat === "wooden" ? "oak_planks" : mat === "stone" ? "cobblestone" : `${mat}_ingot`;
				const resource = items.find((it) => it.name === resourceName || it.name === mat);

				// 必要素材数の簡易チェック（剣:2, メット:5, チェスト:8, レギンス:7, ブーツ:4）
				const REQUIRED_MATERIALS = {
					sword: 2,
					helmet: 5,
					chestplate: 8,
					leggings: 7,
					boots: 4,
				} as const;

				type EquipmentType = keyof typeof REQUIRED_MATERIALS;

				// 判定ロジック
				// type をあらかじめ EquipmentType | string として受けている想定
				const required = REQUIRED_MATERIALS[type as EquipmentType] ?? 0;

				if (resource && resource.count >= required) {
					return { skillType: type, material: mat };
				}
			}
		}
		return null;
	},
	// ... 前回の determineNextSkill もここにある
};
