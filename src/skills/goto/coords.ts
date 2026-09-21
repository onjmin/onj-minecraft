import { createSkill, type SkillResponse, skillResult } from "../types";

export const gotoCoordsSkill = createSkill<
	{ x: number; y?: number; z: number },
	{ x: number; y: number | null; z: number }
>({
	name: "goto.coords",
	description:
		"Moves to specific coordinates. x and z are required; y is optional (omit it for a surface destination given as x,z, such as a hazard-zone exit).",
	inputSchema: {
		x: { type: "number", description: "Target X coordinate" },
		y: {
			type: "number",
			description:
				"Target Y coordinate (optional; omit to walk to x,z at whatever height the ground is)",
			optional: true,
		},
		z: { type: "number", description: "Target Z coordinate" },
	},
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ x: number; y: number | null; z: number }>> => {
		// LLM が壊れた引数を出すことがあるため、使う前に必ず検証する。
		// 検証しないと undefined や NaN のまま移動処理に入り、
		// 到達しない目標に対してタイムアウトまで粘ることになる。
		const x = Number(args?.x);
		const z = Number(args?.z);
		if (!Number.isFinite(x) || !Number.isFinite(z)) {
			return skillResult.fail(
				`Invalid coordinates: got (${args?.x}, ${args?.y}, ${args?.z}). Provide numeric x and z (y is optional).`,
			);
		}
		// y は省いてよい。危険域の出口のように「地表のこの x,z」で渡される
		// 場所に高さは無い。実測 2026-09-20、出口 (x=-52, z=93) を LLM が
		// (x:-52, y:93, z:0) と読み替え、90ブロック逆へ歩き出した。
		const y = args?.y === undefined || args?.y === null ? null : Number(args.y);
		if (y !== null && !Number.isFinite(y)) {
			return skillResult.fail(`Invalid y coordinate: got ${args?.y}. Omit y or give a number.`);
		}

		// 危険域の中を行き先にするかは LLM が決める。SITUATION と hazard zone の
		// 一覧に「中にいる／縁から何ブロック」が出ているので、知った上で選んだ
		// なら行く。以前はここで拒否していた(実測 2026-09-19、58回のうち大半が
		// 穴の中の作業台向き)が、それは LLM に見せる情報が無かったからで、
		// 拒否はコード側の判断だった。ログには残す。
		if (agent.isInHazard({ x, z })) {
			agent.log(`[goto.coords] (${x}, ${z}) は危険域の中。LLM の選択なので向かう`);
		}

		agent.log(`[goto.coords] Moving to (${x}, ${y ?? "any height"}, ${z})`);

		// 遠い目標は 1 回では着かない。制限時間は距離に応じて延ばし(最大 90 秒)、
		// 着かなくても目標へ 16 ブロック以上近づいたなら「進んだ」として返す。
		// 移動は目的ではなく手段なので、近づいたことが成果。以前は時間切れで
		// 失敗にしていたため、300 ブロック先を目指す手が LLM から見て「毎回失敗
		// する手」になり、遠征が始まらなかった(2026-09-21、オーナーの指摘)。
		const start = agent.driver.getState().position;
		const distanceBefore = Math.hypot(x - start.x, z - start.z);
		const timeoutMs = Math.round(Math.min(90_000, Math.max(30_000, distanceBefore * 1_000)));
		const advanced = (): { moved: number; remaining: number } => {
			const now = agent.driver.getState().position;
			const remaining = Math.hypot(x - now.x, z - now.z);
			return { moved: Math.round(distanceBefore - remaining), remaining: Math.round(remaining) };
		};
		try {
			if (y === null) {
				await agent.driver.goto(signal, { kind: "xz", x, z, distance: 2 }, { timeoutMs });
			} else {
				await agent.driver.goto(
					signal,
					{ kind: "near", position: { x, y, z }, distance: 2 },
					{ timeoutMs },
				);
			}
			return skillResult.ok(`Moved to coordinates (${x}, ${y ?? "surface"}, ${z}).`, { x, y, z });
		} catch (err) {
			const { moved, remaining } = advanced();
			if (!signal.aborted && moved >= 16) {
				return skillResult.ok(
					`Advanced ${moved} blocks toward (${x}, ${z}); ${remaining} blocks remaining. Call goto.coords with the same x,z again to continue.`,
					{ x, y, z },
				);
			}
			return skillResult.fail(
				`Failed to reach coordinates: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
