/**
 * 隠れる。LLM が選ぶ籠り。
 *
 * 反射の shelter は「夜で丸腰」「瀕死で敵が近い」「死に続けている」という
 * 既定でしか動かない。装備があっても矢が飛んでくる夜、昼でも敵に囲まれた
 * とき、LLM が「いまは隠れて待つ」と判断する場面はそれ以外にもある。
 * 以前はそれを実行する経路が無く、LLM は「Hide: yes」で反射に任せるか、
 * 穴を掘る別のスキルを選ぶしかなかった。
 *
 * 動作は反射と同じ(寝床があれば戻る、無ければその場に潜る)。1回の呼び出しは
 * 1手ぶんで、続けて選べば続く。出るのも LLM の判断(goto.surface など)。
 */
import { createSkill, type SkillResponse, skillResult } from "../types";

export const survivalHideSkill = createSkill<void, { sheltered: boolean }>({
	name: "survival.hide",
	description:
		"Takes cover: returns to your registered bed if it is close, otherwise digs a small hole and seals yourself in. Use it to wait out night, arrows, or a mob crowd. Re-choose it to keep hiding; choose goto.surface or another skill to come out. Your night reflex does the same thing automatically when you are unarmed unless you say Hide: no.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ sheltered: boolean }>> => {
		const { sheltered } = await agent.hideNow(signal);
		return sheltered
			? skillResult.ok("You are under cover (sealed in or at your bed).", { sheltered })
			: skillResult.fail(
					"Could not get under cover here (nothing to dig into or bed unreachable).",
				);
	},
});
