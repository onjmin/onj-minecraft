import type { BotDriver, Position } from "../../core/driver/types";
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
/**
 * 地表を探す高さの幅。自分の Y を基準に、上へ SCAN_UP・下へ SCAN_DOWN 見る。
 *
 * 以前は 60..120 の決め打ちだった。Java版はワールド全体を引けるので気付き
 * にくいが、統合版の world はサイドカーから受け取った自分中心の立方体
 * (BlockView, 半径16) しか持たない。Y=34 に落ちた状態では 60..120 が丸ごと
 * 範囲外になり、全部の blockAt が null を返して候補が1つも見つからない。
 * 「埋まっているので地上へ戻れ」と言われた場面で毎回そうなる。
 * 読める範囲は自分の周りなので、基準も自分の Y にする。
 *
 * 下も見るのは、丘の中腹に埋まったときの出口が自分より低いことがあるため。
 * ただし「足場＋頭上2マスの空気」だけで選ぶと、自分が落ちてきた洞窟や
 * 掘ってきた縦穴が候補になり、地上へ戻れと言われて下へ潜る。候補には
 * 空が見えていることを必ず確かめる（skyAbove）。
 */
const SCAN_UP = 48;
const SCAN_DOWN = 16;
/** ワールドの高さの上下限。ここを外れる座標は引くだけ無駄。 */
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 320;
/** これだけ上がれていれば、途中でも成果として認める。 */
const PARTIAL_CLIMB = 3;

function isTransparent(name: string): boolean {
	return !name || name === "air" || name === "water" || name === "lava";
}

/** その列の上の状態。unknown は「読めていない」であって「空」ではない。 */
type SkyState = "open" | "roofed" | "unknown";

/**
 * fromY から上に空が見えているかを見る。
 *
 * 未取得(null)を空気と同じに扱わないのが肝。統合版の world はボット中心の
 * 立方体(半径16)しか持たないので、頭上16より上は地形の有無に関わらず null に
 * なる。null に当たったらそこで打ち切り、そこまでに空気を1マスでも読めて
 * いれば「空」と見なす。1マスも読めていなければ unknown を返す。
 *
 * BlockView が届く前は全部 null になる。そこを「空」と答えていたので、
 * 地下にいても「もう地表にいる」と即答して何もしないことがあった。
 *
 * 限界も書いておく。高さ16を超える空洞の中では、天井が立方体の外に出て
 * しまい open と区別できない。半径16のデータでこれ以上は判別できない。
 */
function skyAbove(driver: BotDriver, x: number, fromY: number, z: number): SkyState {
	let air = 0;
	for (let y = fromY; y <= fromY + SKY_SCAN_HEIGHT; y++) {
		const block = driver.world.blockAt({ x, y, z });
		if (block === null) break;
		// 水や溶岩を「透過」として扱うと水没中に地表と誤判定する。空気だけを空と見なす。
		if (block.name !== "air") return "roofed";
		air++;
	}
	return air > 0 ? "open" : "unknown";
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
		// 頭上を1つずつ見て、空気以外に当たれば屋根の下。
		//
		// 「1マスも読めていない」を空扱いにしないこと。BlockView が届く前や
		// 立方体の外にいる間は全部 null になり、地下にいても地表と即答して
		// 何もせずに終わる。判定は skyAbove に寄せてある。
		const headY = startY + 1;
		const sky = skyAbove(driver, Math.floor(currentPos.x), headY + 1, Math.floor(currentPos.z));
		if (sky === "open") {
			agent.log(`[goto.surface] Already on the surface at Y=${startY}.`);
			return skillResult.ok(`Already on the surface at Y=${startY}.`, {
				y: startY,
				method: "already-surface",
			});
		}

		agent.log(`[goto.surface] Current Y: ${startY}, searching for surface...`);

		const radii = [16, 8, 4];
		let targetPos: Position | null = null;

		// 自分の Y を基準にした走査帯。上を優先して見たいので上から下へ回す。
		const scanTop = Math.min(WORLD_MAX_Y, startY + SCAN_UP);
		const scanBottom = Math.max(WORLD_MIN_Y, startY - SCAN_DOWN);

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

				for (let ty = scanTop; ty >= scanBottom; ty--) {
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
						// 足場と頭上の空きだけでは洞窟の床と区別がつかない。
						// up1/up2 は既に空気と分かっているので、その上から見る。
						if (skyAbove(driver, tx, ty + 3, tz) !== "open") continue;

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
