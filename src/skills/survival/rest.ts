/**
 * その場に留まる。ハエの脳(BRAIN=fly)だけが使う。
 *
 * ハエの出力が身繕いか無言のとき、最後に選んだ行動(歩き回る等)が回り
 * 続けると、脳が止まっているのに体だけ動いて見える。止まったことを体で
 * 表すための行動。LLM の一覧には載せない(選べる手が増えると選択が
 * 荒れる: bedrock-skills.ts の冒頭)。
 */
import { createSkill, skillResult } from "../types";

const REST_MS = 4_000;

export const restSkill = createSkill<Record<string, never>>({
	name: "survival.rest",
	description: "Stays still for a few seconds.",
	inputSchema: {},
	handler: async ({ agent, signal }) => {
		agent.driver.stopMoving();
		agent.driver.clearControlStates();
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, REST_MS);
			signal.addEventListener("abort", () => {
				clearTimeout(t);
				resolve();
			});
		});
		return skillResult.okVoid("Stayed still.");
	},
});
