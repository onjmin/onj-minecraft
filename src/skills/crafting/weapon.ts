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
		const { driver } = agent;

		// 1. 次に作るべき装備を判定
		if (signal?.aborted) return skillResult.fail("Aborted");
		const target = craftingManager.determineNextWeapon(agent);
		if (!target) {
			return skillResult.fail("All combat equipment is already at the highest possible quality.");
		}

		// 2. 作成対象に応じて必要な材料の下準備
		if (target.skillType === "sword") {
			// 剣の作成には棒が1本必要（なければ板材・原木から作る）
			const sticksReady = await ensureSticks(agent, 1);
			if (!sticksReady) {
				return skillResult.fail(
					"Insufficient materials: Need sticks (or wood to make them) to craft a sword.",
				);
			}
			if (target.material === "wooden") {
				// 木の剣なら板材2枚が必要
				if (!(await ensurePlanks(agent, 2))) {
					return skillResult.fail(
						"Insufficient materials: Need at least 2 planks to craft a wooden sword.",
					);
				}
			}
		} else if (target.skillType === "shield") {
			// 盾なら板材6枚が必要
			if (!(await ensurePlanks(agent, 6))) {
				return skillResult.fail(
					"Insufficient materials: Need at least 6 planks to craft a shield.",
				);
			}
		}
		// 防具（helmet, chestplate, leggings, boots）は革・鉄・ダイヤ等で作るため追加の木材は不要

		try {
			// 3. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent);

			if (!craftingTable)
				return skillResult.fail("Crafting table is required for weapon maintenance.");

			// 4. 装備のクラフト
			const itemName =
				target.skillType === "shield" ? "shield" : `${target.material}_${target.skillType}`;
			if (!driver.canCraft(itemName, craftingTable.position)) {
				return skillResult.fail(`Insufficient materials for ${itemName}.`);
			}

			await driver.craft(itemName, 1, craftingTable.position);

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

/**
 * 装備の種類ごとに「実在する素材」だけを、良い順に並べたもの。
 *
 * 以前は剣も防具も同じ materials 表を引いていた。しかし木や石の防具は
 * Minecraft に存在しない。板材を持っているだけで wooden_helmet が、
 * 丸石を5個持っているだけで stone_helmet が「次に作るもの」として選ばれ、
 * 当然どちらも作れずに失敗していた。剣を既に持っている間はこれが延々と続く。
 *
 * 防具の素材は革・鉄・金・ダイヤ。チェーンは通常クラフトできないので入れない。
 * 金は防具としては脆く、鉄より先に作る意味がないので候補から外す。
 * 革は牛から取れるので、序盤に実際に作れる唯一の防具になる。
 */
const MATERIALS_BY_TYPE: Record<string, string[]> = {
	sword: ["diamond", "iron", "stone", "wooden"],
	helmet: ["diamond", "iron", "leather"],
	chestplate: ["diamond", "iron", "leather"],
	leggings: ["diamond", "iron", "leather"],
	boots: ["diamond", "iron", "leather"],
};

/** 素材から作るのに要る個数。剣は素材2＋棒1。 */
const REQUIRED_COUNT: Record<string, number> = {
	sword: 2,
	helmet: 5,
	chestplate: 8,
	leggings: 7,
	boots: 4,
};

/** その素材を1個ぶん数えるときに見るアイテム名。 */
function resourceNameFor(material: string): string | null {
	switch (material) {
		case "wooden":
			return null; // 板材はタグで来るので個別に数える
		case "stone":
			return "cobblestone";
		case "leather":
			return "leather";
		case "diamond":
			// ダイヤは精錬しないので diamond_ingot というアイテムは無い。
			// `${material}_ingot` の一律で引いていたため、ダイヤを何個持って
			// いても0個と数えられ、ダイヤの剣も防具も一度も作られなかった。
			return "diamond";
		default:
			return `${material}_ingot`;
	}
}

/** 盾の材料。板材6枚と鉄1個。 */
const SHIELD_PLANKS = 6;

// craftingManager に武器用ロジックを追加
export const craftingManager = {
	// 良い順。防具に使えるかは MATERIALS_BY_TYPE 側で絞る。
	materials: ["diamond", "iron", "gold", "stone", "wooden", "leather"],
	weaponTypes: ["sword", "shield", "helmet", "chestplate", "leggings", "boots"],

	determineNextWeapon: (agent: MinecraftAgent): { skillType: string; material: string } | null => {
		const items = agent.driver.inventory.items();
		const worn = agent.driver.inventory.armor();

		for (const type of craftingManager.weaponTypes) {
			// 盾は素材の概念が特殊（基本木+鉄）なので個別処理
			if (type === "shield") {
				const hasShield = items.some((it) => it.name === "shield");
				const iron = items.some((it) => it.name === "iron_ingot");
				// 盾は板材6枚と鉄1個。板材1枚あるだけで「作れる」と答えて
				// いたため、材料が足りないまま盾を選び続けて失敗し、盾より
				// 後ろにある防具へ一度も進めなかった。原木は1本で板材4枚。
				const planks = items
					.filter((it) => it.name.endsWith("_planks"))
					.reduce((sum, it) => sum + it.count, 0);
				const logs = items
					.filter(
						(it) =>
							it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
					)
					.reduce((sum, it) => sum + it.count, 0);
				if (!hasShield && iron && planks + logs * 4 >= SHIELD_PLANKS) {
					return { skillType: "shield", material: "iron" };
				}
				continue;
			}

			// その装備で実在する素材だけを見る。存在しない木・石の防具を
			// 候補にすると、作れないものを選んでは失敗するだけになる。
			const ladder = MATERIALS_BY_TYPE[type];
			if (!ladder) continue;

			// 同じ品目が複数スロットに散っていることがあるので、合計で数える。
			// スロット単位で見ると、丸石が3+3の2山にあるとき「5個に足りない」と
			// 判定して、実際には作れるものを作らない。
			const total = (name: string): number =>
				items.reduce((sum, it) => (it.name === name ? sum + it.count : sum), 0);

			// 今持っている最良の素材の順位。持っていなければ ladder の外。
			//
			// 着ている防具も数える。items() には出てこないので、持ち物だけを
			// 見ると鉄をフル装備していても「1つも持っていない」ことになり、
			// 同じ防具を作り直し続けて鉄を使い切る。
			let currentBestIdx = ladder.length;
			for (const item of [...items, ...worn]) {
				if (item?.name.endsWith(`_${type}`)) {
					const mat = item.name.slice(0, -`_${type}`.length);
					const idx = ladder.indexOf(mat);
					if (idx !== -1 && idx < currentBestIdx) currentBestIdx = idx;
				}
			}

			const need = REQUIRED_COUNT[type] ?? 1;

			for (let i = 0; i < ladder.length; i++) {
				// 今持っているものと同等以下なら作り直す意味がない。
				if (i >= currentBestIdx) continue;

				const mat = ladder[i];
				if (mat === "wooden") {
					// 板材はタグ指定なので種類を問わない。原木からでも作れる。
					const planks = items
						.filter((it) => it.name.endsWith("_planks"))
						.reduce((sum, it) => sum + it.count, 0);
					const logs = items
						.filter(
							(it) =>
								it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
						)
						.reduce((sum, it) => sum + it.count, 0);
					// 原木1本で板材4枚。足りるかは板材に換算して見る。
					if (planks + logs * 4 >= need) {
						return { skillType: type, material: mat };
					}
					continue;
				}

				const resourceName = resourceNameFor(mat);
				if (!resourceName) continue;
				if (total(resourceName) >= need) {
					return { skillType: type, material: mat };
				}
			}
		}
		return null;
	},
};
