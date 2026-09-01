import type { BotDriver } from "../../core/driver/types";
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
		const { driver } = agent;

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
		// 道具に3枚、作業台に4枚。まとめて確保する。
		await ensurePlanks(agent, 7);

		// 1. 次に作るべきツールと素材を判定
		const target = craftingManager.determineNextSkill(driver);
		agent.log(
			`[craftTool] Target tool: ${target ? `${target.material}_${target.skillType}` : "none"}`,
		);

		if (!target) {
			return skillResult.fail(
				"No tools to craft. Already have the best possible equipment with current materials.",
			);
		}

		const itemName = `${target.material}_${target.skillType}`;
		const maxCraft = 3;

		try {
			// 2. 作業台の確保
			const craftingTable = await ensureCraftingTable(agent);
			agent.log(`[craftTool] Crafting table: ${craftingTable ? "found" : "not found"}`);

			if (!craftingTable) {
				return skillResult.fail(
					"Crafting table is not nearby. Please place one to proceed with maintenance.",
				);
			}

			// 3. レシピの確認とクラフト
			const canCraft = driver.canCraft(itemName, craftingTable.position);
			agent.log(`[craftTool] Recipe for ${itemName}: found=${canCraft}`);

			if (!canCraft) {
				return skillResult.fail(`Insufficient materials or no recipe for ${itemName}.`);
			}

			// 最大3個まで、1個ずつクラフトする。
			//
			// まとめて3個を頼んではいけない。素材が1個ぶんしか無いのが普通で
			// （determineNextSkill は素材3個＝道具1個で選ぶ）、足りなければ
			// クラフト全体が例外になる。実際に作れていても catch に落ちて
			// 「Crafting interrupted」を返すので、最初の1本すら成功として
			// 記録されず、次の周でまた同じ道具を作ろうとしていた。
			// 作れたところまでを成果にする。
			let crafted = 0;
			for (let i = 0; i < maxCraft; i++) {
				const before = totalOf(driver.inventory.items(), itemName);
				try {
					await driver.craft(itemName, 1, craftingTable.position);
				} catch (craftErr) {
					agent.log(`[craftTool] ${i + 1}個目で止まった: ${craftErr}`);
					break;
				}
				// 例外を投げずに何もしない実装もある。増えていなければ打ち切る。
				if (totalOf(driver.inventory.items(), itemName) <= before) break;
				crafted++;
			}

			if (crafted === 0) {
				return skillResult.fail(`Insufficient materials for ${itemName}.`);
			}
			agent.log(`[craftTool] SUCCESS: Crafted ${crafted} ${itemName}`);

			return skillResult.ok(`Upgraded equipment: Crafted ${crafted} ${itemName}.`, {
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
 * 品目の合計を数える。
 *
 * スロット単位で見てはいけない。同じ物が複数の山に分かれていることがあり、
 * 丸石が 2+2 の2山にあるとき「3個に足りない」と判定して、実際には作れる
 * 石の道具を作らないまま素手で掘り続けることになる。
 */
function totalOf(items: { name: string; count: number }[], name: string): number {
	return items.reduce((sum, it) => (it.name === name ? sum + it.count : sum), 0);
}

/**
 * 装備の接頭辞から、素材として数えるアイテム名を引く。
 *
 * 表に無いものは `${mat}_ingot` で足りる（iron_ingot）。
 */
const RESOURCE_ITEM: Record<string, string> = {
	golden: "gold_ingot",
	diamond: "diamond",
};

/**
 * Specialized manager for crafting decisions
 * クラフトの意思決定を管理するマネージャー
 */
export const craftingManager = {
	// 優先順位: ダイヤモンド > 鉄 > 金 > 石 > 木
	//
	// 金は "gold" ではなく "golden"。道具と防具のアイテムIDは golden_pickaxe /
	// golden_helmet であって gold_pickaxe ではない。ここが "gold" だったため、
	// 金インゴットを3個持っているだけでこのループが金を選び、存在しない
	// gold_pickaxe を作ろうとして失敗していた。しかも最初に見つけた素材で
	// return するので、その先の石や木に落ちてこない。つまり金を拾うと
	// 道具が一切作れなくなっていた。素材として数えるのは gold_ingot のまま。
	materials: ["diamond", "iron", "golden", "stone", "wooden"],
	// 優先順位: ピッケル > オノ > シャベル > クワ
	types: ["pickaxe", "axe", "shovel", "hoe"],

	determineNextSkill: (driver: BotDriver): { skillType: string; material: string } | null => {
		const items = driver.inventory.items();

		for (const type of craftingManager.types) {
			// 現在そのカテゴリで持っている最高の素材と数を特定
			let currentBestIdx = 999;
			for (const item of items) {
				if (item.name.endsWith(`_${type}`)) {
					const mat = item.name.split("_")[0];
					const idx = craftingManager.materials.indexOf(mat);
					if (idx !== -1 && idx < currentBestIdx) {
						currentBestIdx = idx;
					}
				}
			}
			// 所持数は最良素材の「最初に見つかった山」ではなく合計で数える。
			// 山で見ると、木のツルハシが 2+2 の2山にあるとき「3本に足りない」と
			// 判定して、要らない道具を作り続ける。
			const currentCount =
				currentBestIdx === 999
					? 0
					: totalOf(items, `${craftingManager.materials[currentBestIdx]}_${type}`);

			// 既に3個以上持っていればスキップ
			if (currentCount >= 3) {
				continue;
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
					// 板材はタグ指定なので種類を問わない。種類ごとに分かれた山を
					// 合算して見る。原木は1本で板材4枚になるので換算して足す。
					const planks = items
						.filter((it) => it.name.endsWith("_planks"))
						.reduce((sum, it) => sum + it.count, 0);
					const logs = items
						.filter(
							(it) =>
								it.name.endsWith("_log") || it.name.endsWith("_stem") || it.name.endsWith("_wood"),
						)
						.reduce((sum, it) => sum + it.count, 0);
					if (planks + logs * 4 >= requiredCount) {
						return { skillType: type, material: mat };
					}
				} else if (mat === "stone") {
					requiredCount = 3;
					if (totalOf(items, "cobblestone") >= requiredCount) {
						return { skillType: type, material: mat };
					}
				} else {
					requiredCount = 3;
					// 素材のアイテム名は装備の接頭辞と一致しない。金は golden_pickaxe を
					// 作るのに gold_ingot を使い、ダイヤは diamond_pickaxe を作るのに
					// diamond を使う。diamond_ingot というアイテムは存在しない。
					// ここが `${mat}_ingot` の一律だったため、ダイヤを何個持っていても
					// 0個と数えられ、ダイヤの道具は一度も作られなかった。
					const resourceName = RESOURCE_ITEM[mat] ?? `${mat}_ingot`;
					if (totalOf(items, resourceName) >= requiredCount) {
						return { skillType: type, material: mat };
					}
				}
			}
		}
		return null;
	},
};
