import type { Position } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

const SAFE_BLOCKS = [
	"dirt",
	"grass_block",
	"stone",
	"cobblestone",
	"granite",
	"diorite",
	"andesite",
	"deepslate",
	"bedrock",
	"sand",
	"gravel",
];

function isSafeBlock(name: string): boolean {
	return (
		SAFE_BLOCKS.includes(name) ||
		name.endsWith("_ore") ||
		name.endsWith("_log") ||
		name.endsWith("_wood")
	);
}

/** 空が見えているかを測る高さ。屋根はこの範囲に収まる前提。 */
const SKY_SCAN_HEIGHT = 32;
/** これだけ上がれていれば、途中でも成果として認める。 */
const PARTIAL_CLIMB = 3;

function isTransparent(name: string): boolean {
	return !name || name === "air" || name === "water" || name === "lava";
}

export const gotoSurfaceSkill = createSkill<void, { y: number; method: string }>({
	name: "goto.surface",
	description:
		"Moves up to reach the surface. Efficiently samples nearby ground levels. Falls back to digging straight up if no path is found.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ y: number; method: string }>> => {
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const currentPos = state.position;
		const startY = Math.floor(currentPos.y);

		// 既に地表にいるなら何もしない。
		//
		// この判定が無いと、空の下に立っているのに半径16内の別の地表を目標に選び、
		// 届かずに失敗し続ける。フォールバックの掘り上がりも頭上が空気なので
		// 何もせず諦める。本番の Realm で7回起動して一度も仕事をしていなかった。
		//
		// 頭上を1つずつ見て、空気以外に当たれば屋根の下。既知のブロックが尽きたら
		// そこから上には何も無い（地形より上のサブチャンクは送られてこない）ので空。
		// 水や溶岩を「透過」として扱うと水没中に地表と誤判定するため、空気だけを空と見なす。
		const headY = startY + 1;
		let roofed = false;
		for (let y = headY + 1; y <= headY + SKY_SCAN_HEIGHT; y++) {
			const above = driver.world.blockAt({
				x: Math.floor(currentPos.x),
				y,
				z: Math.floor(currentPos.z),
			});
			if (above === null) break;
			if (above.name !== "air") {
				roofed = true;
				break;
			}
		}
		if (!roofed) {
			agent.log(`[goto.surface] Already on the surface at Y=${startY}.`);
			return skillResult.ok(`Already on the surface at Y=${startY}.`, {
				y: startY,
				method: "already-surface",
			});
		}

		agent.log(`[goto.surface] Current Y: ${startY}, searching for surface...`);

		const radii = [16, 8, 4];
		let targetPos: Position | null = null;

		search: for (const radius of radii) {
			const attempts = radius <= 4 ? 4 : Math.min(12, radius);

			for (let i = 0; i < attempts; i++) {
				if (signal.aborted) {
					return skillResult.fail("Aborted");
				}

				const angle = Math.random() * Math.PI * 2;
				const dist = Math.random() * radius;
				const tx = Math.floor(currentPos.x + Math.cos(angle) * dist);
				const tz = Math.floor(currentPos.z + Math.sin(angle) * dist);

				for (let ty = 120; ty >= 60; ty--) {
					const block = driver.world.blockAt({ x: tx, y: ty, z: tz });
					const up1 = driver.world.blockAt({ x: tx, y: ty + 1, z: tz });
					const up2 = driver.world.blockAt({ x: tx, y: ty + 2, z: tz });

					if (!block || !up1 || !up2) continue;

					if (
						!isTransparent(block.name) &&
						isSafeBlock(block.name) &&
						isTransparent(up1.name) &&
						isTransparent(up2.name)
					) {
						targetPos = { x: tx + 0.5, y: ty + 1, z: tz + 0.5 };
						agent.log(`[goto.surface] Found surface at (${tx}, ${ty}, ${tz}), radius=${radius}`);
						break search;
					}
				}
			}
		}

		if (targetPos) {
			try {
				await agent.driver.goto(signal, { kind: "near", position: targetPos, distance: 1 });
				return skillResult.ok(`Reached surface at Y=${Math.floor(targetPos.y)}.`, {
					y: Math.floor(targetPos.y),
					method: "pathfinder",
				});
			} catch (err) {
				agent.log(`[goto.surface] Pathfinding failed, falling back to dig-up: ${err}`);
			}
		}

		agent.log(`[goto.surface] No surface path found, attempting dig-up...`);

		const digUpTargetY = Math.min(320, startY + 30);
		let currentDigY = startY;

		// 掘り上がりは1ブロックに数秒かかる。30ブロック掘り切るまで成功と
		// 認めないと、地下深くからは何度やっても失敗になる。実測で64回試して
		// 成功率0%。上がったぶんを成果として返す。
		const climbed = () => Math.floor(driver.getState().position.y) - startY;
		const partial = (): SkillResponse<{ y: number; method: string }> | null => {
			const gained = climbed();
			if (gained < PARTIAL_CLIMB) return null;
			return skillResult.ok(`Climbed ${gained} blocks toward the surface.`, {
				y: startY + gained,
				method: "dig-up-partial",
			});
		};

		while (currentDigY < digUpTargetY) {
			if (signal.aborted) {
				return partial() ?? skillResult.fail("Aborted");
			}

			const checkPos: Position = {
				x: Math.floor(currentPos.x),
				y: currentDigY + 1,
				z: Math.floor(currentPos.z),
			};
			const block = driver.world.blockAt(checkPos);
			const above = driver.world.blockAt({ ...checkPos, y: checkPos.y + 1 });

			if (!block || block.name === "air") {
				currentDigY++;
				continue;
			}

			if (!above || above.name === "air") {
				try {
					await driver.goto(signal, { kind: "near", position: checkPos, distance: 1 });
					return skillResult.ok(`Reached surface at Y=${checkPos.y}.`, {
						y: checkPos.y,
						method: "dig-up",
					});
				} catch {
					currentDigY++;
					continue;
				}
			}

			agent.log(`[goto.surface] Digging up at Y=${currentDigY + 1}...`);
			await driver.equipBestTool(checkPos);

			try {
				await driver.dig(signal, checkPos);
				await new Promise((r) => setTimeout(r, 100));
			} catch {
				return partial() ?? skillResult.fail("Dig-up aborted or failed");
			}

			// 掘っただけでは登れない。縦穴が伸びるだけでボットは底に残る。
			// 経路探索が柱積み(stepTower)を持つので、そちらに登らせる。
			// スキル側で登り方を持つと、経路探索の持つ手と二重になる。
			try {
				await driver.goto(signal, {
					kind: "near",
					position: { x: checkPos.x, y: checkPos.y, z: checkPos.z },
					distance: 1,
				});
			} catch {
				return partial() ?? skillResult.fail("Could not climb: nothing to stand on.");
			}

			currentDigY = Math.floor(driver.getState().position.y);
		}

		return partial() ?? skillResult.fail("Could not reach surface.");
	},
});
