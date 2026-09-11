import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * 覚えている人工物へ向かう。
 *
 * 地上に出ても行き先が無いと、その場でランダムに歩き回るだけになる。実測で
 * 7日間、Known Bases は空のまま、死亡地点は約40ブロック四方に収まっていた。
 * 作業台・かまど・チェスト・ベッド・松明のように人の手が入ったものが見えたら
 * それは誰かの拠点なので、そちらへ向かう。
 *
 * どこを覚えているかは agent 側が持つ(noteLandmarksNearby)。ここは向かうだけ。
 *
 * 着いても壊さない・取らない。人の家である前提で扱う。
 */
export const gotoLandmarkSkill = createSkill<void, { x: number; z: number; what: string }>({
	name: "goto.landmark",
	description:
		"Walks toward the nearest man-made structure you have seen (crafting table, furnace, chest, bed, torches, planks). Use this when you are on the surface with nothing to gather nearby — wandering at random never arrives anywhere.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ x: number; z: number; what: string }>> => {
		const landmarks = agent.getKnownLandmarks();
		const target = landmarks[0];
		if (!target) {
			return skillResult.fail("No man-made structure has been seen yet.");
		}

		const here = agent.driver.getState().position;
		const dist = Math.hypot(target.position.x - here.x, target.position.z - here.z);
		agent.log(
			`[goto.landmark] ${target.name} (${target.position.x}, ${target.position.y}, ${target.position.z}) へ向かう（${dist.toFixed(0)}ブロック）`,
		);

		try {
			// Y は合わせない。建物は自分と違う高さにあることが多く、ぴったり
			// 合わせようとすると屋根の上や床下を目標にして届かなくなる。
			// 水平に着けば、あとは見えている範囲で判断できる。
			await agent.driver.goto(signal, {
				kind: "xz",
				x: target.position.x,
				z: target.position.z,
				distance: 3,
			});
			// 水平に着いただけでは「着いた」と言えない。XZ で合わせているので、
			// 地下から向かうと拠点の真下 65 ブロックで「到着」になる。
			// そこを成功と報告すると、次の判断が「もう拠点にいる」前提で進む。
			const arrived = agent.driver.getState().position;
			const gap = Math.round(target.position.y - arrived.y);
			if (gap > 3) {
				return skillResult.ok(
					`Directly below a ${target.name} someone built, but it is ${gap} blocks above. Get to the surface first.`,
					{ x: target.position.x, z: target.position.z, what: target.name },
				);
			}
			return skillResult.ok(`Arrived at a ${target.name} someone built.`, {
				x: target.position.x,
				z: target.position.z,
				what: target.name,
			});
		} catch (err) {
			// 届かなくても、近づいたぶんは無駄ではない。次の周でまた寄る。
			const now = agent.driver.getState().position;
			const left = Math.hypot(target.position.x - now.x, target.position.z - now.z);
			if (left < dist - 4) {
				return skillResult.ok(
					`Moved ${(dist - left).toFixed(0)} blocks toward a ${target.name} (${left.toFixed(0)} to go).`,
					{ x: target.position.x, z: target.position.z, what: target.name },
				);
			}
			return skillResult.fail(
				`Could not reach the ${target.name}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
