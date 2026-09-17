import { describeGain, gainedSince, snapshotInventory, totalGain } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";
import { ensureFurnace } from "./util";

/** かまどが1つ焼くのにかかる時間。統合版は10秒。 */
const SMELT_MS_PER_ITEM = 10_000;
/** 焼き上がりを待つ上限。 */
const SMELT_WAIT_MAX_MS = 70_000;

/**
 * Smelting Domain: Processing raw materials.
 * 精錬ドメイン：原料の加工。
 * かまどを確保し、レシピデータに基づいて焼けるアイテムと燃料を自動選別して投入します。
 */
export const craftSmeltingSkill = createSkill<void, { item: string; amount: number }>({
	name: "crafting.smelting",
	description:
		"Automatically identifies smeltable items and fuels using recipe data, and starts the smelting process. Also supports creating charcoal (from wood/logs) for crafting torches.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ item: string; amount: number }>> => {
		const { driver } = agent;

		// 1. かまどの確保（util.ts の共通関数を使用）
		const furnaceBlock = await ensureFurnace(agent);
		if (!furnaceBlock) {
			return skillResult.fail(
				"Could not secure a furnace. Cobblestone (8) and a crafting table are required.",
			);
		}

		const items = driver.inventory.items();

		// 2. 精錬対象（Input）の厳密な判定
		// かまどのレシピデータにそのアイテムが材料として含まれているかを確認
		const smeltable = items.find((item) => driver.canSmelt(item.name));

		if (!smeltable) {
			return skillResult.fail("No items in inventory can be smelted in a furnace.");
		}

		// 3. 燃料（Fuel）の厳密な判定
		// レジストリの燃焼時間(fuelDuration)データがある、または伝統的な燃料アイテム
		const fuel = items.find((item) => {
			const name = item.name;
			return (
				["coal", "charcoal", "coal_block", "lava_bucket", "blaze_rod", "dead_bush"].includes(
					name,
				) ||
				name.endsWith("_planks") ||
				name.endsWith("_log") ||
				name.endsWith("_wood") ||
				name.endsWith("_stem") ||
				["stick", "crafting_table", "chest", "barrel", "ladder", "bowl"].includes(name)
			);
		});

		if (!fuel) {
			return skillResult.fail("No suitable fuel found in inventory.");
		}

		try {
			// 4. かまどを開いて投入（燃料は最大スタック、素材は手持ちすべて）
			const before = snapshotInventory(driver);
			await driver.smelt(
				furnaceBlock.position,
				smeltable.name,
				smeltable.count,
				fuel.name,
				fuel.count,
			);

			// 5. 焼き上がるまで待って、取り出すところまでやる。
			//
			// 投入した時点で成功を返していたので、焼けた物はかまどの中に
			// 置き去りのまま「精錬した」と報告していた。持ち物は増えず、
			// 次に通りかかっても中身は見ない。狩った肉が焼けないまま
			// 腐っていく経路がここにあった。
			const waitMs = Math.min(SMELT_MS_PER_ITEM * smeltable.count + 3_000, SMELT_WAIT_MAX_MS);
			agent.log(
				`[smelting] ${smeltable.name} x${smeltable.count} を焼く。${Math.round(waitMs / 1000)}秒待つ`,
			);
			const until = Date.now() + waitMs;
			while (Date.now() < until) {
				if (signal.aborted) break;
				await new Promise((r) => setTimeout(r, 2_000));
			}
			await driver.takeAllFromContainer(signal, furnaceBlock.position);

			const gained = gainedSince(driver, before);
			if (totalGain(gained) === 0) {
				agent.noteStall(
					`Put ${smeltable.name} into a furnace but nothing could be taken back out.`,
				);
				return skillResult.fail(
					`Put ${smeltable.name} into the furnace but nothing came back out.`,
				);
			}

			return skillResult.ok(
				`Smelted ${smeltable.count}x ${smeltable.name} and collected ${describeGain(gained)}.`,
				{
					item: smeltable.name,
					amount: smeltable.count,
				},
			);
		} catch (err) {
			return skillResult.fail(
				`Smelting action failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
