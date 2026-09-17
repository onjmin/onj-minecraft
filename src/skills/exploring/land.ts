import type { Position } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * これだけ動けていなければ、探索として成立していないと見なす。
 *
 * 目的地に着くこと自体は成果ではない。1ブロック先へ行って「着いた」を
 * 返し続けても、読み込まれる地形は増えない。
 */
const MIN_EXPLORE_MOVE = 6;

export const exploreLandSkill = createSkill<void, { x: number; z: number }>({
	name: "exploring.explore_land",
	description:
		"Explores the nearby surface by sampling safe ground. Heads toward the nearest man-made structure you have seen, otherwise prioritizes the forward direction.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ x: number; z: number }>> => {
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const currentPos = state.position;
		const currentY = Math.floor(currentPos.y);
		const yaw = state.yaw; // 現在の向き

		// 行き先を知っているなら、そちらへ寄せる。
		//
		// 前方優先とはいえ向き自体はランダムに変わるので、結局その場を
		// うろつくだけになる。実測で7日間、地上に出ても拠点に一度も
		// 到達せず Known Bases は空のままだった。見かけた建物を覚えて
		// いるなら、探索もそちらを向いて行う。
		//
		// 角度の取り方は下の dx/dz と揃えること。
		// dx = -sin(a)*d, dz = -cos(a)*d なので、方向ベクトル(vx,vz)に
		// 対応する角度は atan2(-vx, -vz)。
		const landmark = agent.getKnownLandmarks()[0];
		let baseAngle = yaw;
		let spread = Math.PI; // ±90度
		if (landmark) {
			const vx = landmark.position.x - currentPos.x;
			const vz = landmark.position.z - currentPos.z;
			// 目の前にあるなら向きを固定する意味が無い。素直に見回す。
			if (Math.hypot(vx, vz) > 6) {
				baseAngle = Math.atan2(-vx, -vz);
				// 寄せる以上は幅を狭める。±90度のままだと横へ逸れて進まない。
				spread = Math.PI / 2; // ±45度
			}
		}

		// --- 1. 段階的・方向優先サンプリング ---
		// 遠く(16)から近く(4)へ、あるいはその逆でも良いですが、
		// 「探索」なら少し遠め(12~16)を最初に狙い、ダメなら手前に落とすのが自然です。
		const radii = [16, 8, 4];
		let targetPos: Position | null = null;

		search: for (const radius of radii) {
			const attempts = 8;
			for (let i = 0; i < attempts; i++) {
				// 前方優先ロジック:
				// 完全にランダムではなく、現在の視線方向に ±90度のバイアスをかける
				const angleOffset = (Math.random() - 0.5) * spread;
				const finalAngle = baseAngle + angleOffset;

				const dist = radius * (0.5 + Math.random() * 0.5); // 半径の50%〜100%の距離
				const dx = Math.floor(-Math.sin(finalAngle) * dist);
				const dz = Math.floor(-Math.cos(finalAngle) * dist);

				const tx = Math.floor(currentPos.x + dx);
				const tz = Math.floor(currentPos.z + dz);

				// 地面探索ロジック
				let foundY: number | null = null;
				for (let dy = 5; dy >= -5; dy--) {
					const block = driver.world.blockAt({ x: tx, y: currentY + dy, z: tz });
					const up1 = driver.world.blockAt({ x: tx, y: currentY + dy + 1, z: tz });
					const up2 = driver.world.blockAt({ x: tx, y: currentY + dy + 2, z: tz });

					if (block?.solid && up1 && !up1.solid && up2 && !up2.solid) {
						// 危険ブロック（溶岩・水）を避ける
						const groundBlock = block;
						if (groundBlock.name !== "water" && groundBlock.name !== "lava") {
							foundY = currentY + dy + 1;
							break;
						}
					}
				}

				if (foundY !== null) {
					// 修正ポイント1: ブロックの真ん中 (+0.5) を狙うことでスタックを激減させる
					targetPos = { x: tx + 0.5, y: foundY, z: tz + 0.5 };
					break search;
				}
			}
		}

		if (!targetPos) {
			return skillResult.fail("No safe ground found in sampling.");
		}

		const before = { ...driver.getState().position };
		try {
			// 修正ポイント2: Goalの精度を調整
			// GoalNearXZ(x, z, 1) は「半径1ブロック以内」で満足してしまうため、
			// 階段の途中で「着いた」と判定して止まり、次の動作で詰まることがあります。
			// 探索なら 0.5 くらいまで詰め寄るのが安全です。
			await Promise.race([
				driver.goto(signal, { kind: "xz", x: targetPos.x, z: targetPos.z, distance: 0.5 }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
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
			return skillResult.ok(`Explored ${moved.toFixed(0)} blocks away.`, {
				x: targetPos.x,
				z: targetPos.z,
			});
		} catch {
			// --- 3. リカバリ (スタック解除) ---
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
