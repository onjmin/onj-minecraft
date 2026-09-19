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

		// 掘り荒らされた区域の中は行き先にしない。実測 2026-09-19、このスキルが
		// 58回選ばれ、ほぼ全部が初期リスの穴の中の作業台に向いていた。
		if (agent.isInHazard({ x, z })) {
			return skillResult.fail(
				`(${x}, ${y}, ${z}) is inside a dug-out hazard zone (cratered ground). Do not go there; explore new terrain on the surface instead.`,
			);
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
