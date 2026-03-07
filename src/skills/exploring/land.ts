import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const exploreLandSkill = createSkill<void, { x: number; z: number }>({
	name: "exploring.explore_land",
	description:
		"Explores the nearby surface by sampling safe ground, prioritizing the forward direction.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ x: number; z: number }>> => {
		const { bot } = agent;
		const currentPos = bot.entity.position;
		const currentY = Math.floor(currentPos.y);
		const yaw = bot.entity.yaw; // 現在の向き

		// --- 1. 段階的・方向優先サンプリング ---
		// 遠く(16)から近く(4)へ、あるいはその逆でも良いですが、
		// 「探索」なら少し遠め(12~16)を最初に狙い、ダメなら手前に落とすのが自然です。
		const radii = [16, 8, 4];
		let targetPos: Vec3 | null = null;

		search: for (const radius of radii) {
			const attempts = 8;
			for (let i = 0; i < attempts; i++) {
				// 前方優先ロジック:
				// 完全にランダムではなく、現在の視線方向に ±90度のバイアスをかける
				const angleOffset = (Math.random() - 0.5) * Math.PI; // ±90度
				const finalAngle = yaw + angleOffset;

				const dist = radius * (0.5 + Math.random() * 0.5); // 半径の50%〜100%の距離
				const dx = Math.floor(-Math.sin(finalAngle) * dist);
				const dz = Math.floor(-Math.cos(finalAngle) * dist);

				const tx = Math.floor(currentPos.x + dx);
				const tz = Math.floor(currentPos.z + dz);

				// 地面探索ロジック
				let foundY: number | null = null;
				for (let dy = 5; dy >= -5; dy--) {
					const checkPos = new Vec3(tx, currentY + dy, tz);
					const block = bot.blockAt(checkPos);
					const up1 = bot.blockAt(checkPos.offset(0, 1, 0));
					const up2 = bot.blockAt(checkPos.offset(0, 2, 0));

					if (
						block?.boundingBox === "block" &&
						up1?.boundingBox === "empty" &&
						up2?.boundingBox === "empty"
					) {
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
					targetPos = new Vec3(tx + 0.5, foundY, tz + 0.5);
					break search;
				}
			}
		}

		if (!targetPos) {
			return skillResult.fail("No safe ground found in sampling.");
		}

		try {
			// 修正ポイント2: Goalの精度を調整
			// GoalNearXZ(x, z, 1) は「半径1ブロック以内」で満足してしまうため、
			// 階段の途中で「着いた」と判定して止まり、次の動作で詰まることがあります。
			// 探索なら 0.5 くらいまで詰め寄るのが安全です。
			const goal = new goals.GoalNearXZ(targetPos.x, targetPos.z, 0.5);

			await Promise.race([
				agent.abortableGoto(signal, goal),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
			]);

			return skillResult.ok("Reached destination.", { x: targetPos.x, z: targetPos.z });
		} catch {
			// --- 3. リカバリ (スタック解除) ---
			bot.clearControlStates();
			// 失敗時は少し後ろに下がってジャンプ（挟まり防止）
			bot.setControlState("back", true);
			bot.setControlState("jump", true);
			await new Promise((r) => setTimeout(r, 500));
			bot.clearControlStates();

			return skillResult.fail("Movement failed or timed out.");
		}
	},
});
