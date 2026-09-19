import type { Position } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * これだけ動けていなければ、探索として成立していないと見なす。
 *
 * 目的地に着くこと自体は成果ではない。1ブロック先へ行って「着いた」を
 * 返し続けても、読み込まれる地形は増えない。
 */
const MIN_EXPLORE_MOVE = 6;

/**
 * 探索の目標までの距離。遠い順に試す。
 *
 * 以前は [16, 8, 4] だった。初期リスの周りは半径48のクレーターで、
 * 16 ブロック先はまだ穴の中。実測 2026-09-19、位置の 76% が初期リスから
 * 32 ブロック以内に収まり、地表にいた時間は 10% だった。資源は水平方向
 * (新しい地形・森・動物・村)にあるので、届く限り遠くを狙う。
 * 遠い目標の地面は blockAt(半径16)では読めないので surfaceScan で見る。
 */
const EXPLORE_RADII = [48, 32, 20, 12];
/** 地表とみなす、その列の上の空き。天井の下(洞窟の床)を地表と呼ばない。 */
const MIN_OPEN_ABOVE = 8;
/** 移動にかける時間。距離に応じて延ばす。 */
const MOVE_TIMEOUT_BASE_MS = 15_000;
const MOVE_TIMEOUT_PER_BLOCK_MS = 700;

export const exploreLandSkill = createSkill<void, { x: number; z: number }>({
	name: "exploring.explore_land",
	description:
		"Explores the surface horizontally toward new terrain (up to ~48 blocks per call). Heads toward the nearest man-made structure you have seen, otherwise away from dug-out hazard zones, otherwise forward. Use this to find forests, animals and villages; resources are found by walking, not by digging down.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ x: number; z: number }>> => {
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const currentPos = state.position;
		const yaw = state.yaw; // 現在の向き

		// 向きを決める。優先順は 目印 > 危険域から離れる > 前方。
		//
		// 角度の取り方は下の dx/dz と揃えること。
		// dx = -sin(a)*d, dz = -cos(a)*d なので、方向ベクトル(vx,vz)に
		// 対応する角度は atan2(-vx, -vz)。
		let baseAngle = yaw;
		let spread = Math.PI; // ±90度
		let heading = "forward";
		const landmark = agent.getKnownLandmarks()[0];
		const zone = agent
			.getHazardZones()
			.find((z) => Math.hypot(z.x - currentPos.x, z.z - currentPos.z) <= z.radius + 8);
		if (
			landmark &&
			Math.hypot(landmark.position.x - currentPos.x, landmark.position.z - currentPos.z) > 6
		) {
			// 行き先を知っているなら、そちらへ寄せる。実測で7日間、地上に
			// 出ても拠点に一度も到達せず Known Bases は空のままだった。
			const vx = landmark.position.x - currentPos.x;
			const vz = landmark.position.z - currentPos.z;
			baseAngle = Math.atan2(-vx, -vz);
			spread = Math.PI / 2; // ±45度
			heading = `toward ${landmark.name}`;
		} else if (zone) {
			// 穴だらけの区域の中か縁にいる。中心から離れる向きへ。
			let vx = currentPos.x - zone.x;
			let vz = currentPos.z - zone.z;
			if (Math.hypot(vx, vz) < 0.5) {
				vx = 1;
				vz = 0;
			}
			baseAngle = Math.atan2(-vx, -vz);
			spread = Math.PI / 2;
			heading = "away from hazard zone";
		}

		// 周りの地表を読む。遠い目標は blockAt では見えない。
		let surface = new Map<string, { y: number; name: string; open: number }>();
		try {
			const cols = await driver.world.surfaceScan(EXPLORE_RADII[0]);
			surface = new Map(cols.map((c) => [`${c.x},${c.z}`, { y: c.y, name: c.name, open: c.open }]));
		} catch {
			// 読めなければ近場だけ blockAt で探す。
		}

		// --- 段階的・方向優先サンプリング ---
		// 遠くから順に、向きに幅を持たせて地面を探す。
		let targetPos: Position | null = null;
		search: for (const radius of EXPLORE_RADII) {
			const attempts = 8;
			for (let i = 0; i < attempts; i++) {
				const angleOffset = (Math.random() - 0.5) * spread;
				const finalAngle = baseAngle + angleOffset;
				const dist = radius * (0.6 + Math.random() * 0.4); // 半径の60%〜100%
				const dx = Math.floor(-Math.sin(finalAngle) * dist);
				const dz = Math.floor(-Math.cos(finalAngle) * dist);
				const tx = Math.floor(currentPos.x + dx);
				const tz = Math.floor(currentPos.z + dz);

				// 危険域の中は目標にしない。
				if (agent.isInHazard({ x: tx, z: tz })) continue;

				const foundY = groundAt(agent, surface, tx, tz, Math.floor(currentPos.y));
				if (foundY !== null) {
					// ブロックの真ん中 (+0.5) を狙うことでスタックを減らす
					targetPos = { x: tx + 0.5, y: foundY, z: tz + 0.5 };
					break search;
				}
			}
		}

		if (!targetPos) {
			return skillResult.fail("No safe ground found in sampling.");
		}

		const before = { ...driver.getState().position };
		const planned = Math.hypot(targetPos.x - before.x, targetPos.z - before.z);
		agent.log(
			`[explore] ${heading}: (${Math.floor(targetPos.x)}, ${targetPos.y}, ${Math.floor(targetPos.z)}) へ ${planned.toFixed(0)} ブロック`,
		);
		// サイドカーの timeoutMs は整数。小数を渡すと命令ごと解釈されずに落ちる。
		const timeoutMs = Math.round(MOVE_TIMEOUT_BASE_MS + planned * MOVE_TIMEOUT_PER_BLOCK_MS);
		try {
			await Promise.race([
				driver.goto(
					signal,
					{ kind: "xz", x: targetPos.x, z: targetPos.z, distance: 1 },
					{ timeoutMs },
				),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs)),
			]);

			// 「着いた」だけで成功にしない。
			//
			// このスキルは目的地に着くので毎回 Success を返していた。何も
			// 得ないまま成功を繰り返せるため、停滞判定(失敗でしか発火しない)
			// も効かない。実測 2026-09-17 01:37、4〜5秒おきに37回連続で
			// 選ばれ、その間ずっと同じ場所におり、最後は探索中に落下死した。
			// 探索の成果は「新しい地形を読み込めたか」で、その代理として
			// 実際に動いた距離を見る。
			const after = driver.getState().position;
			const moved = Math.hypot(after.x - before.x, after.z - before.z);
			if (moved < MIN_EXPLORE_MOVE) {
				agent.noteStall(
					`exploring.explore_land: "arrived" after moving only ${moved.toFixed(1)} blocks; exploring here finds nothing new.`,
				);
				return skillResult.fail(
					`Arrived but only moved ${moved.toFixed(1)} blocks; nothing new was explored.`,
				);
			}
			return skillResult.ok(`Explored ${moved.toFixed(0)} blocks ${heading}.`, {
				x: targetPos.x,
				z: targetPos.z,
			});
		} catch (err) {
			// 届かなくても、進んだぶんは無駄ではない。
			const after = driver.getState().position;
			const moved = Math.hypot(after.x - before.x, after.z - before.z);
			if (moved >= MIN_EXPLORE_MOVE) {
				return skillResult.ok(
					`Moved ${moved.toFixed(0)} blocks ${heading} before the path ran out.`,
					{ x: targetPos.x, z: targetPos.z },
				);
			}
			if (signal.aborted) throw err;
			// --- リカバリ (スタック解除) ---
			// スタック解除はベストエフォート。中断済みでも必ず実行したいので、
			// AbortSignal を見る setControlState ではなく素の操作で行う。
			try {
				driver.clearControlStates();
				// 失敗時は少し後ろに下がってジャンプ（挟まり防止）
				await driver.setControlState(new AbortController().signal, "back", true);
				await driver.setControlState(new AbortController().signal, "jump", true);
				await new Promise((r) => setTimeout(r, 500));
			} finally {
				driver.clearControlStates();
			}

			return skillResult.fail("Movement failed or timed out.");
		}
	},
});

/**
 * その列で立てる地面の高さ。無ければ null。
 *
 * まず surfaceScan の列(空が見えている一番上の固いブロック)を見る。
 * 上の空きが少ない列は天井の下なので、地表と呼ばない。水と溶岩は避ける。
 * 列が読めていなければ、近場だけ blockAt で上下5マスを探す。
 */
function groundAt(
	agent: { driver: { world: { blockAt(p: Position): { solid: boolean; name: string } | null } } },
	surface: Map<string, { y: number; name: string; open: number }>,
	tx: number,
	tz: number,
	currentY: number,
): number | null {
	const col = surface.get(`${tx},${tz}`);
	if (col) {
		if (col.open < MIN_OPEN_ABOVE) return null;
		if (col.name === "water" || col.name === "lava") return null;
		return col.y + 1;
	}
	const world = agent.driver.world;
	for (let dy = 5; dy >= -5; dy--) {
		const block = world.blockAt({ x: tx, y: currentY + dy, z: tz });
		const up1 = world.blockAt({ x: tx, y: currentY + dy + 1, z: tz });
		const up2 = world.blockAt({ x: tx, y: currentY + dy + 2, z: tz });
		if (block?.solid && up1 && !up1.solid && up2 && !up2.solid) {
			if (block.name !== "water" && block.name !== "lava") return currentY + dy + 1;
		}
	}
	return null;
}
