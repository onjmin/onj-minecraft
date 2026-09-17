/**
 * 食料を確保する。狩って、焼いて、食べるまでを一続きで行う。
 *
 * 生存は鎖になっている。
 *   食料 → 自然回復 → 夜を越す → 持ち物を保つ → 道具 → もっと良い食料
 * これまで1本目が繋がっていなかった。統合版の自然回復は満腹度18以上でしか
 * 起きないので、食料が無いと体力が戻らず、削られて死に、持ち物を全部落とし、
 * 毎回ゼロから始まる。実測、5日ぶんのログ全体で食事は23回、狩りの起動は
 * 34回しかなく、10時間走ったあとの持ち物は dirt だけだった。
 *
 * 途中の各段は「やったか」ではなく「増えたか」で判定する。狩りスキルは
 * 動物を殴れば成功を返していたが、倒せたか・拾えたかは見ていなかった。
 * 精錬スキルは投入した時点で成功を返し、焼き上がりを取り出していなかった。
 * どちらも報告だけが通って、持ち物は空のままになる。
 */
import { COOKABLE_FOOD, EAT_BELOW_FOOD, pickCookable, pickFood } from "../../core/driver/food";
import { huntAnimalsSkill } from "../collecting/hunting";
import { ensureFurnace } from "../crafting/util";
import { describeGain, gainedSince, snapshotInventory } from "../inventory-delta";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** かまどが1つ焼くのにかかる時間。統合版は10秒。 */
const SMELT_MS_PER_ITEM = 10_000;
/** 焼き上がりを待つ上限。まとめて焼くと長いので頭を打たせる。 */
const SMELT_WAIT_MAX_MS = 70_000;

export interface SecureFoodResult {
	/** eat / cook / hunt のどれを行ったか。 */
	step: string;
	/** 得たもの、または回復した満腹度。 */
	gained: string;
}

export const secureFoodSkill = createSkill<void, SecureFoodResult>({
	name: "survival.secure_food",
	description:
		"Secures food end to end: eats what is edible, cooks raw meat in a furnace and takes the result out, or hunts a nearby animal. Health does not regenerate below hunger 18, so this is the prerequisite for surviving anything else.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<SecureFoodResult>> => {
		const { driver } = agent;
		const names = () => driver.inventory.items().map((i) => i.name);

		// 1. 食べられる物があるなら食べる。満腹度が戻ったかで判定する。
		const edible = pickFood(names());
		if (edible && driver.getState().food < EAT_BELOW_FOOD) {
			const before = driver.getState().food;
			const ate = await driver.eat(signal);
			const after = driver.getState().food;
			if (ate && after > before) {
				agent.noteMeal(before, after);
				return skillResult.ok(`Ate ${edible}: hunger ${before} -> ${after}.`, {
					step: "eat",
					gained: `満腹度 +${after - before}`,
				});
			}
			// 食べたつもりで増えていない。次の手に落とす。
			agent.noteStall(`Ate ${edible} but hunger stayed at ${before}.`);
		}

		// 2. 生肉があるなら焼く。焼き上がりを取り出すところまでやる。
		const raw = pickCookable(names());
		if (raw) {
			const cooked = COOKABLE_FOOD.get(raw) ?? "";
			const furnace = await ensureFurnace(agent);
			if (!furnace) {
				return skillResult.fail(
					`Have raw ${raw} but no furnace (needs 8 cobblestone and a crafting table).`,
				);
			}
			const items = driver.inventory.items();
			const rawItem = items.find((i) => i.name === raw);
			const fuel = items.find(
				(i) =>
					["coal", "charcoal", "coal_block", "blaze_rod"].includes(i.name) ||
					i.name.endsWith("_planks") ||
					i.name.endsWith("_log") ||
					i.name === "stick",
			);
			if (!rawItem) return skillResult.fail(`Raw ${raw} disappeared from the inventory.`);
			if (!fuel) return skillResult.fail(`No fuel to cook ${raw} (coal, logs or planks).`);

			const before = snapshotInventory(driver);
			await driver.smelt(furnace.position, raw, rawItem.count, fuel.name, Math.min(fuel.count, 8));

			// 焼き上がるまで待つ。投入した時点で成功を返していたのが以前の形で、
			// かまどの中に置き去りにしたまま「精錬した」と報告していた。
			const waitMs = Math.min(SMELT_MS_PER_ITEM * rawItem.count + 3_000, SMELT_WAIT_MAX_MS);
			agent.log(
				`[secure_food] ${raw} x${rawItem.count} を焼く。${Math.round(waitMs / 1000)}秒待つ`,
			);
			const until = Date.now() + waitMs;
			while (Date.now() < until) {
				if (signal.aborted) break;
				await new Promise((r) => setTimeout(r, 2_000));
			}
			await driver.takeAllFromContainer(signal, furnace.position);

			const gained = gainedSince(driver, before);
			if ((gained.get(cooked) ?? 0) > 0) {
				return skillResult.ok(`Cooked and collected ${describeGain(gained)}.`, {
					step: "cook",
					gained: describeGain(gained),
				});
			}
			agent.noteStall(`Smelted ${raw} but no ${cooked} could be taken out of the furnace.`);
			return skillResult.fail(`Smelted ${raw} but no ${cooked} came back out of the furnace.`);
		}

		// 3. 何も無いなら狩る。肉が増えたかどうかだけを見る。
		const before = snapshotInventory(driver);
		const hunt = await huntAnimalsSkill.handler({ agent, signal, args: undefined as never });
		const gained = gainedSince(driver, before);
		const meat = [...gained.keys()].filter((n) => COOKABLE_FOOD.has(n) || pickFood([n]) !== null);
		if (meat.length > 0) {
			return skillResult.ok(`Hunted and picked up ${describeGain(gained)}.`, {
				step: "hunt",
				gained: describeGain(gained),
			});
		}
		if (!hunt.success) {
			// 動物がいないことは、次の判断の材料になる。黙って失敗を返すと
			// 同じ選択を繰り返される。実測、ローカルの採点で30秒に9回。
			if (hunt.error.includes("No animals")) {
				agent.noteStall(
					"No animals anywhere nearby; hunting requires moving somewhere else first.",
				);
			}
			return skillResult.fail(hunt.error);
		}
		agent.noteStall("Killed an animal but no food ended up in the inventory.");
		return skillResult.fail("Attacked an animal but no food ended up in the inventory.");
	},
});
