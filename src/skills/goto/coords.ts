import { createSkill, type SkillResponse, skillResult } from "../types";

export const gotoCoordsSkill = createSkill<
	{ x: number; y: number; z: number },
	{ x: number; y: number; z: number }
>({
	name: "goto.coords",
	description: "Moves to specific coordinates (x, y, z). Use when you know the target location.",
	inputSchema: {
		x: { type: "number", description: "Target X coordinate" },
		y: { type: "number", description: "Target Y coordinate" },
		z: { type: "number", description: "Target Z coordinate" },
	},
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ x: number; y: number; z: number }>> => {
		// LLM が壊れた引数を出すことがあるため、使う前に必ず検証する。
		// 検証しないと undefined や NaN のまま移動処理に入り、
		// 到達しない目標に対してタイムアウトまで粘ることになる。
		const x = Number(args?.x);
		const y = Number(args?.y);
		const z = Number(args?.z);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
			return skillResult.fail(
				`Invalid coordinates: got (${args?.x}, ${args?.y}, ${args?.z}). Provide numeric x, y and z.`,
			);
		}

		// 危険域の中を行き先にするかは LLM が決める。SITUATION と hazard zone の
		// 一覧に「中にいる／縁から何ブロック」が出ているので、知った上で選んだ
		// なら行く。以前はここで拒否していた(実測 2026-09-19、58回のうち大半が
		// 穴の中の作業台向き)が、それは LLM に見せる情報が無かったからで、
		// 拒否はコード側の判断だった。ログには残す。
		if (agent.isInHazard({ x, z })) {
			agent.log(`[goto.coords] (${x}, ${z}) は危険域の中。LLM の選択なので向かう`);
		}

		agent.log(`[goto.coords] Moving to (${x}, ${y}, ${z})`);

		try {
			await agent.driver.goto(signal, { kind: "near", position: { x, y, z }, distance: 2 });
			return skillResult.ok(`Moved to coordinates (${x}, ${y}, ${z}).`, { x, y, z });
		} catch (err) {
			return skillResult.fail(
				`Failed to reach coordinates: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
