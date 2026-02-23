import type { Bot } from "mineflayer";
import type { AgentOrchestrator } from "../../core/agent";
import { createTool, type ToolResponse, toolResult } from "../types";
import { ensureCraftingTable } from "./util";

/**
 * Crafting Domain: Weapon and Armor maintenance.
 * クラフトドメイン：武器防具の維持管理。
 * 剣、盾、防具一式のうち、最もアップグレードが必要なものを1つ作成します。
 */
export const craftWeaponTool = createTool<void, { item: string; material: string }>({
	name: "crafting.weapon",
	description:
		"Automatically crafts the best weapon or armor (Sword > Shield > Armor) you don't have yet.",
	inputSchema: {} as any,
	handler: async (
		agent: AgentOrchestrator,
	): Promise<ToolResponse<{ item: string; material: string }>> => {
		const { bot } = agent;

		// 1. 次に作るべき装備を判定
		const target = craftingManager.determineNextWeapon(bot);
		if (!target) {
			return toolResult.fail("All combat equipment is already at the highest possible quality.");
		}

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent.bot);

			// (作業台の設置・作成ロジックは craftToolTool と同様なので、実際には共通関数化を推奨)
			if (!craftingTable)
				return toolResult.fail("Crafting table is required for weapon maintenance.");

			// 3. 装備のクラフト
			const itemName =
				target.toolType === "shield" ? "shield" : `${target.material}_${target.toolType}`;
			const item = bot.registry.itemsByName[itemName];
			const recipes = bot.recipesFor(item.id, null, 1, craftingTable);

			if (recipes.length === 0) {
				return toolResult.fail(`Insufficient materials for ${itemName}.`);
			}

			await bot.craft(recipes[0], 1, craftingTable);

			return toolResult.ok(`Battle readiness improved: Crafted 1 ${itemName}.`, {
				item: target.toolType,
				material: target.material,
			});
		} catch (err) {
			return toolResult.fail(
				`Weapon crafting failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});

// craftingManager に武器用ロジックを追加
export const craftingManager = {
	materials: ["diamond", "iron", "gold", "stone", "wooden"],
	weaponTypes: ["sword", "shield", "helmet", "chestplate", "leggings", "boots"],

	determineNextWeapon: (bot: Bot): { toolType: string; material: string } | null => {
		const items = bot.inventory.items();

		for (const type of craftingManager.weaponTypes) {
			// 盾は素材の概念が特殊（基本木+鉄）なので個別処理
			if (type === "shield") {
				const hasShield = items.some((it) => it.name === "shield");
				const iron = items.find((it) => it.name === "iron_ingot");
				const planks = items.find((it) => it.name.endsWith("_planks"));
				if (!hasShield && iron && planks && planks.count >= 1) {
					return { toolType: "shield", material: "iron" };
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
					return { toolType: type, material: mat };
				}
			}
		}
		return null;
	},
	// ... 前回の determineNextTool もここにある
};
