/**
 * 食べる。何を食べるかは LLM が決める。
 *
 * 反射 eat は「食べてよいもの」(pickFood)しか食べない。生の鶏肉は食中毒が
 * あるので pickFood が外している。だが満腹度13で生の鶏肉3枚を持ち、他に
 * 何も無いとき、それを食べるかどうかは判断であって、コードが「絶対に
 * 食べない」と決めることではない。実測 2026-09-19 23:50、LLM は
 * 「生の鶏肉をいま食べる」と5周続けて書いたが、それを実行する経路が無く、
 * secure_food が「かまどが無い」で131回失敗した。
 *
 * item を省けば pickFood の優先順位で選ぶ(反射と同じ)。
 */
import { NEVER_EAT, pickFood } from "../../core/driver/food";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const survivalEatSkill = createSkill<{ item?: string }, { item: string; hunger: number }>({
	name: "survival.eat",
	description:
		"Eats one item from your inventory. Without an argument it picks the best safe food. Pass item to eat something specific, including raw meat: raw beef/porkchop/mutton restore about half of cooked; raw chicken restores 2 hunger with a 30% chance of a short Hunger effect (not lethal). Eating is the only way to restore health when hunger is below 18.",
	inputSchema: {
		item: {
			type: "string",
			description: "Item name to eat (e.g. chicken, mutton, cooked_beef). Optional.",
			optional: true,
		},
	},
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ item: string; hunger: number }>> => {
		const { driver } = agent;
		const names = driver.inventory.items().map((i) => i.name);
		const want = typeof args?.item === "string" && args.item.trim() ? args.item.trim() : null;
		const item = want ?? pickFood(names);
		if (!item) {
			return skillResult.fail("Nothing edible in inventory (and no item was specified).");
		}
		if (!names.includes(item)) {
			return skillResult.fail(`You do not carry any ${item}.`);
		}
		// 腐った肉はここに入れない。満腹度 +4 が戻り、80% で短い空腹効果が付くだけで
		// 致死ではない(オーナー確認 2026-09-20)。以前は「毒で戻らない」と誤って
		// 断っていた。食べるかどうかは LLM の判断。
		if (want && ["pufferfish", "poisonous_potato", "spider_eye"].includes(want)) {
			// 毒物は食べても満腹度が戻らず体力を削る。これは判断ではなく事実。
			return skillResult.fail(`${want} poisons you and does not restore hunger. Not eating it.`);
		}
		const before = driver.getState().food;
		if (before >= 20) {
			return skillResult.fail("Hunger is already full (20/20); you cannot eat now.");
		}
		const ate = await driver.eat(signal, item);
		const after = driver.getState().food;
		if (!ate || after <= before) {
			return skillResult.fail(`Tried to eat ${item} but hunger stayed at ${before}.`);
		}
		agent.noteMeal(before, after);
		const risky = NEVER_EAT.has(item) ? " (raw; watch for the Hunger effect)" : "";
		return skillResult.ok(`Ate ${item}${risky}: hunger ${before} -> ${after}.`, {
			item,
			hunger: after,
		});
	},
});
