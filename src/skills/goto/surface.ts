import type { MinecraftAgent } from "../../core/agent";
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
/**
 * 刻んだ段に乗れたかを確かめるまでの待ち。
 *
 * 跳んでいる途中の高さを成功と読まないための間。落下と着地が収まる程度で
 * よく、長く取ると1段ごとにこれだけ足される。
 */
const SETTLE_MS = 500;
/** これだけ上がれていれば、途中でも成果として認める。 */
const PARTIAL_CLIMB = 3;
/** サイドカーに地表を数えさせる半径。持っているチャンクの範囲に収める。 */
const FAR_SURFACE_RADIUS = 24;
/**
 * 自分の列の地表がこれより上なら「地下にいる」と見なす。
 *
 * 1〜2マスのずれは、立っているブロックの上面と地表の数え方の差で出る。
 * それを地下と呼ぶと、地上にいるのに毎回登り直すことになる。
 */
const SURFACE_GAP = 3;
/**
 * 地表と認めるのに要る頭上の空き。
 *
 * 少ないと、洞窟の天井にある1マスの空洞を地表と読んでしまう。
 * 空の下なら数十マス空いているので、そこそこ大きく取ってよい。
 */
const MIN_OPEN_ABOVE = 8;

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

/**
 * 横へ1歩ぶんずらして1段上がる足場を掘り、そこへ登る。
 *
 * 真上へ掘るだけでは縦穴が伸びるだけで、登るには足元に何か置くしかない。
 * 手ぶらのときはそれができないので、代わりに階段を刻む。掘るだけで登れる
 * ので、持ち物が空でも地上へ戻れる。
 *
 * 1段ぶんの形:
 *   - (x+dx, y,   z+dz) … 踏み台。ここは残す（空なら別の向きを試す）
 *   - (x+dx, y+1, z+dz) … 足を置く場所。塞がっていれば掘る
 *   - (x+dx, y+2, z+dz) … 頭の場所。塞がっていれば掘る
 *   - (x,    y+2, z)    … 跳ぶための頭上の空き。塞がっていれば掘る
 *
 * 登れたら true。どの向きも成立しなければ false。
 */
async function digStepUp(agent: MinecraftAgent, signal: AbortSignal): Promise<boolean> {
	if (await tryDigStepUp(agent, signal)) return true;
	// 四方どこにも踏み台が無い。広い穴の底に立っているときで、初期リスの
	// クレーターがまさにそれ。実測 2026-09-19、Y=33 で「nothing to stand on」を
	// 3分間繰り返して取り上げられた。壁まで歩けば階段は刻める。
	if (!(await approachWall(agent, signal))) return false;
	return tryDigStepUp(agent, signal);
}

const STEP_DIRS = [
	{ dx: 1, dz: 0 },
	{ dx: -1, dz: 0 },
	{ dx: 0, dz: 1 },
	{ dx: 0, dz: -1 },
];

/** 壁を探す範囲。これより遠い壁へ歩くくらいなら、次の周で測り直す。 */
const WALL_SEARCH_RADIUS = 8;

/**
 * 足の高さに固いブロックがあり、その隣に立てる場所がある、一番近い所へ歩く。
 * 着いたら true。見つからない・届かないなら false。掘らない。
 */
async function approachWall(agent: MinecraftAgent, signal: AbortSignal): Promise<boolean> {
	const { driver } = agent;
	const here = driver.getState().position;
	const fx = Math.floor(here.x);
	const fy = Math.floor(here.y);
	const fz = Math.floor(here.z);
	const solidAt = (x: number, y: number, z: number): boolean => {
		const b = driver.world.blockAt({ x, y, z });
		return !!b && b.solid && b.name !== "water" && b.name !== "lava";
	};
	const airAt = (x: number, y: number, z: number): boolean => {
		const b = driver.world.blockAt({ x, y, z });
		return !!b && b.name === "air";
	};

	let best: { x: number; z: number; d: number } | null = null;
	for (let dx = -WALL_SEARCH_RADIUS; dx <= WALL_SEARCH_RADIUS; dx++) {
		for (let dz = -WALL_SEARCH_RADIUS; dz <= WALL_SEARCH_RADIUS; dz++) {
			const wx = fx + dx;
			const wz = fz + dz;
			if (!solidAt(wx, fy, wz)) continue;
			for (const n of STEP_DIRS) {
				const sx = wx + n.dx;
				const sz = wz + n.dz;
				// 立てる場所: 足と頭が空いていて、足元が固い。
				if (!airAt(sx, fy, sz) || !airAt(sx, fy + 1, sz) || !solidAt(sx, fy - 1, sz)) continue;
				const d = Math.hypot(sx - here.x, sz - here.z);
				if (d < 0.8) continue; // ここに立っている。踏み台があるなら上で見つかっている
				if (!best || d < best.d) best = { x: sx, z: sz, d };
			}
		}
	}
	if (!best) return false;
	agent.log(
		`[goto.surface] 隣に踏み台が無い。${best.d.toFixed(0)} ブロック先の壁 (${best.x}, ${fy}, ${best.z}) まで歩く`,
	);
	try {
		await driver.goto(
			signal,
			{ kind: "near", position: { x: best.x + 0.5, y: fy, z: best.z + 0.5 }, distance: 0.6 },
			{ timeoutMs: 15_000 },
		);
	} catch {
		// 届かなくても、近づいたぶんで踏み台が見つかることがある。
	}
	const now = driver.getState().position;
	return Math.hypot(now.x - here.x, now.z - here.z) >= 1;
}

async function tryDigStepUp(agent: MinecraftAgent, signal: AbortSignal): Promise<boolean> {
	const { driver } = agent;
	const here = driver.getState().position;
	const fx = Math.floor(here.x);
	const fy = Math.floor(here.y);
	const fz = Math.floor(here.z);

	const dirs = STEP_DIRS;

	for (const { dx, dz } of dirs) {
		if (signal.aborted) return false;

		const stand = driver.world.blockAt({ x: fx + dx, y: fy, z: fz + dz });
		// 踏み台が無い向きへ登ろうとすると、ただ穴へ落ちる。
		// 未取得(null)も「有る」ことの根拠にならないので避ける。
		if (!stand || !stand.solid) continue;
		// 水や溶岩の上には立てない。
		if (stand.name === "water" || stand.name === "lava") continue;

		const toClear: Position[] = [
			{ x: fx + dx, y: fy + 1, z: fz + dz },
			{ x: fx + dx, y: fy + 2, z: fz + dz },
			{ x: fx, y: fy + 2, z: fz },
		];

		let blocked = false;
		for (const p of toClear) {
			const b = driver.world.blockAt(p);
			if (!b || b.name === "air") continue;
			if (!b.diggable) {
				blocked = true;
				break;
			}
			try {
				await driver.equipBestTool(p);
				await driver.dig(signal, p);
			} catch {
				blocked = true;
				break;
			}
		}
		if (blocked) continue;

		try {
			await driver.goto(signal, { kind: "block", position: { x: fx + dx, y: fy + 1, z: fz + dz } });
		} catch {
			continue;
		}

		// 実際に上がれたかで判断する。経路探索が「着いた」と言っても、
		// Y が変わっていなければ登れていない。
		//
		// 登った「瞬間」で見てはいけない。跳んだ頂点や、刻んだ段の角に
		// 乗りかけたところを掴むと、その後ずり落ちても成功として返る。
		// 実測 2026-09-16、判定とログで getState() を別々に引いていたため
		// 「Y=41 から登って Y=41」「Y=28 から登って Y=28」というログが
		// 出ていた。判定は上がったと言い、その直後には元の高さに戻っている。
		// 落ち着くまで待ってから、一度引いた値だけで決める。
		await new Promise((r) => setTimeout(r, SETTLE_MS));
		const settledY = Math.floor(driver.getState().position.y);
		if (settledY > fy) {
			agent.log(`[goto.surface] Cut a step and climbed to Y=${settledY}.`);
			return true;
		}
	}

	return false;
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
		const myX = Math.floor(currentPos.x);
		const myZ = Math.floor(currentPos.z);

		// 本物の地表をサイドカーに数えさせる。ここで先に引くのは、
		// 「もう地表にいる」の判断にも要るため。
		//
		// skyAbove(BlockView)だけでは決められない。半径16の外は null になり、
		// 高さ16を超える洞窟の中では天井が立方体から出てしまって「空」と
		// 区別がつかない。実測 2026-09-13、Y=39 の洞窟で
		// 「Already on the surface at Y=39」を返し続け、地表(Y=66)へ
		// 一度も上がらないまま8分間そこにいた。反射は「地下に埋まっている」と
		// 918回言っているのに、スキルが「もう地上だ」と即答して噛み合わない。
		let columns: { x: number; z: number; y: number; name: string; open: number }[] = [];
		try {
			columns = await driver.world.surfaceScan(FAR_SURFACE_RADIUS);
		} catch {
			// 数えられなくても、下の近距離走査で続ける。
		}
		// 自分の列がそのまま返るとは限らない。読めていない列は返らないので、
		// 見つからなければ一番近い列で代用する。実測、同じ場所で
		// 「Already on the surface at Y=39」と「Y=39 は地下」が交互に出た。
		const myColumn =
			columns.find((c) => c.x === myX && c.z === myZ) ??
			columns
				.filter((c) => Math.abs(c.x - myX) <= 2 && Math.abs(c.z - myZ) <= 2)
				.sort((a, b) => Math.hypot(a.x - myX, a.z - myZ) - Math.hypot(b.x - myX, b.z - myZ))[0];

		const sky = skyAbove(driver, myX, headY + 1, myZ);
		// 自分の列の地表が分かっているなら、そちらを正とする。頭上が
		// 空いて見えても、地表がずっと上なら地下にいる。
		const buriedByScan = myColumn ? myColumn.y > startY + SURFACE_GAP : false;
		if (sky === "open" && !buriedByScan) {
			agent.log(`[goto.surface] Already on the surface at Y=${startY}.`);
			return skillResult.ok(`Already on the surface at Y=${startY}.`, {
				y: startY,
				method: "already-surface",
			});
		}
		if (buriedByScan && myColumn) {
			agent.log(
				`[goto.surface] Y=${startY} は地下。自分の列の地表は Y=${myColumn.y}（${myColumn.y - startY} 上）`,
			);
		}

		agent.log(`[goto.surface] Current Y: ${startY}, searching for surface...`);

		// 数えた地表から目標を選ぶ。
		//
		// 半径16の写し(BlockView)だけで探すと、深く掘り抜かれた穴の底では
		// 本物の地表が丸ごと範囲外になり、穴の途中の棚を地表と誤認する。
		// 実測 2026-09-12、Y=13 にいて真上 Y=61 が地表なのに
		// 「Found surface at (2, 24, 61)」と棚を掴み、届かず失敗、を
		// 繰り返して初期リスの穴から抜け出せなかった。
		// 列を辿るだけの計算なので、チャンクを持っている側にやらせる。
		let targetPos: Position | null = null;
		if (columns.length > 0) {
			// 自分より高く、空きが十分ある列の中から、近い順に選ぶ。
			const candidates = columns
				.filter((c) => c.y > startY && c.open >= MIN_OPEN_ABOVE && isSafeBlock(c.name))
				.sort(
					(a, b) =>
						Math.hypot(a.x - currentPos.x, a.z - currentPos.z) -
						Math.hypot(b.x - currentPos.x, b.z - currentPos.z),
				);
			const best = candidates[0];
			if (best) {
				targetPos = { x: best.x + 0.5, y: best.y + 1, z: best.z + 0.5 };
				agent.log(
					`[goto.surface] Real surface at (${best.x}, ${best.y}, ${best.z}), ${best.y - startY} above, open=${best.open}`,
				);
			}
		}

		const radii = [16, 8, 4];

		// 自分の Y を基準にした走査帯。上を優先して見たいので上から下へ回す。
		const scanTop = Math.min(WORLD_MAX_Y, startY + SCAN_UP);
		const scanBottom = Math.max(WORLD_MIN_Y, startY - SCAN_DOWN);

		search: for (const radius of targetPos ? [] : radii) {
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

		// 頭上が塞がっていて、地表がずっと上にあるなら、経路探索は通らない。
		// 経路の手は「既にある空洞を登る」ものしか無く、天井を掘って
		// 上がる手は持っていない。実測、毎回30秒かけて「経路 0手」で
		// 失敗してから掘り上がりに落ちていた。先に掘る。
		const ceiling = driver.world.blockAt({ x: myX, y: startY + 2, z: myZ });
		const roofed = !!ceiling && ceiling.name !== "air";
		const farBelow = myColumn ? myColumn.y - startY > 4 : false;
		if (targetPos && roofed && farBelow) {
			agent.log("[goto.surface] 頭上が塞がっている。経路探索を飛ばして掘り上がる");
			targetPos = null;
		}

		if (targetPos) {
			try {
				await agent.driver.goto(signal, {
					kind: "near",
					position: targetPos,
					distance: 1,
					// 地上へ戻る道は掘ってよい。天井の下にいるときは、
					// 掘る手を外すと一手も選べず「経路 0手」で終わる。
					dig: true,
				});
				return skillResult.ok(`Reached surface at Y=${Math.floor(targetPos.y)}.`, {
					y: Math.floor(targetPos.y),
					method: "pathfinder",
				});
			} catch (err) {
				agent.log(`[goto.surface] Pathfinding failed, falling back to dig-up: ${err}`);
			}
		}

		agent.log(`[goto.surface] No surface path found, attempting dig-up...`);

		// 掘り上がりの終点。自分の列の本物の地表を使う。
		//
		// skyAbove だけで「着いた」と判断してはいけない。洞窟の天井が
		// BlockView(半径16)の外にあると、空気しか読めずに open を返す。
		// 実測 2026-09-13、Y=39 で掘り上がりに入った直後に
		// 「Reached surface」と即答して1ブロックも掘らずに終わり、
		// それを何十回も繰り返していた。
		const surfaceY = myColumn ? myColumn.y : null;

		const MAX_CLIMB = 30;
		/** 同じ高さで足踏みしてよい回数。超えたらこの列では上がれない。 */
		const STUCK_LIMIT = 3;

		// 途中まで登れたなら、そのぶんは報告する。ただし成功とは呼ばない。
		//
		// 元は「30ブロック掘り切るまで成功と認めないと、地下深くからは何度
		// やっても失敗になる(実測64回試して成功率0%)」という理由で、3ブロック
		// 以上登れていれば ok を返していた。これが指標を壊していた。
		// 選択のプロンプトにはスキルごとの成功率が添えられる(skillReliability)
		// ので、LLM はこの数字で手応えを測る。実測 2026-09-16、298回試して
		// 失敗は135回、つまり成功率55%と表示されながら、8時間で一度も地表に
		// 出ていない。3マス登って落ちる往復が「まあまあ効いている手段」として
		// 見えていた。地表に着いていないなら失敗。進んだ距離と残りは文面に
		// 入れるので、進捗そのものは LLM から見えたままになる。
		const climbedBlocks = () => Math.floor(driver.getState().position.y) - startY;
		const partial = (): SkillResponse<{ y: number; method: string }> | null => {
			const gained = climbedBlocks();
			if (gained < PARTIAL_CLIMB) return null;
			const nowY = startY + gained;
			const remain =
				surfaceY !== null ? ` Still ${surfaceY - nowY} below the surface (Y=${surfaceY}).` : "";
			return skillResult.fail(`Climbed ${gained} blocks but did not reach the surface.${remain}`);
		};

		// 掘るのは「頭のすぐ上」だけにする。
		//
		// 以前は、頭上が空いていると掘る目標だけを上へ進めていた。ボットは
		// 動かないので、Y=0 に立ったまま Y=5 の天井を掘る、ということが起きる。
		// 掘れても間に4マスの空きが残り、そこを越える手段は無いので一歩も
		// 上がらない。実測 2026-09-12 は Y=0〜2 を往復し続け、毎周
		// 「Digging up at Y=5」だけを出していた。
		//
		// 目標を手の届く1マスに固定し、上がるのは経路探索と階段に任せる。
		let lastY = startY;
		let stuck = 0;
		/** 経路探索(柱積み)がまだ見込みがあるか。一度失敗したら二度と頼まない。 */
		let pillarUpWorks = true;

		while (climbedBlocks() < MAX_CLIMB) {
			if (signal.aborted) {
				return partial() ?? skillResult.fail("Aborted");
			}

			const here = driver.getState().position;
			const fx = Math.floor(here.x);
			const fy = Math.floor(here.y);
			const fz = Math.floor(here.z);

			// 地表の高さまで上がれたら終わり。
			// 数えられていないときだけ、頭上の見え方で判断する。
			const arrived =
				surfaceY !== null ? fy >= surfaceY - 1 : skyAbove(driver, fx, fy + 2, fz) === "open";
			if (arrived) {
				return skillResult.ok(`Reached surface at Y=${fy}.`, { y: fy, method: "dig-up" });
			}

			const headAbove: Position = { x: fx, y: fy + 2, z: fz };
			const block = driver.world.blockAt(headAbove);
			// 水は掘らない。掘っても穴にならず、そのまま浮いて上がれる。
			// 溶岩も掘らない（掘れば降ってくる）。
			if (block && block.name !== "air" && block.name !== "water") {
				if (block.name === "lava") {
					return partial() ?? skillResult.fail("Lava directly overhead; cannot dig up here.");
				}
				if (!block.diggable) {
					return partial() ?? skillResult.fail("The block overhead cannot be broken.");
				}
				agent.log(`[goto.surface] Digging up at Y=${headAbove.y}...`);
				await driver.equipBestTool(headAbove);
				try {
					await driver.dig(signal, headAbove);
					await new Promise((r) => setTimeout(r, 100));
				} catch {
					return partial() ?? skillResult.fail("Dig-up aborted or failed");
				}
			}

			// 水の中なら、まず浮いて上がる。
			//
			// 水没した洞窟では足場が無いので階段は掘れず、柱積みも置く物が
			// 要る。実測 2026-09-12、Y=1 の水没洞窟で四方が水だったため
			// digStepUp が全方向を弾き、3周で「上がれない」と返して4秒で
			// 終わっていた。人は水中でジャンプを押しっぱなしにして浮上する。
			// 同じことをする。
			const feetBlock = driver.world.blockAt({ x: fx, y: fy, z: fz });
			const headBlock = driver.world.blockAt({ x: fx, y: fy + 1, z: fz });
			if (feetBlock?.name === "water" || headBlock?.name === "water") {
				try {
					await driver.setControlState(signal, "jump", true);
					await new Promise((r) => setTimeout(r, 1200));
				} finally {
					await driver.setControlState(signal, "jump", false);
				}
				if (Math.floor(driver.getState().position.y) > fy) {
					// 浮けた。掘る必要も歩く必要もない。
					stuck = 0;
					lastY = Math.floor(driver.getState().position.y);
					continue;
				}
			}

			// 1マス上がる。まず経路探索(柱積み)に任せ、駄目なら階段を掘る。
			//
			// ただし一度駄目だったら、この呼び出しの間はもう頼まない。
			// 柱積みは置けるブロックが要るので、手ぶらのまま同じ場所で
			// 何度呼んでも結果は変わらない。実測 2026-09-16、足踏み3回で
			// 失敗するまでの90秒はほぼこの待ちで、その間に刻めた段は0。
			// 待つのをやめたぶんを階段掘りの試行に回す。
			// 柱積みは手元に置けるブロックが要るので、死んで手ぶらの状態では
			// 階段だけが頼りになる。
			//
			// 目標は「2マス上」にする。到達判定は高さ1.5マスまでを許すので、
			// 1マス上を目標にすると、立っているその場所が最初から到達条件を
			// 満たしてしまう。経路探索は即座に成功を返し、ボットは一度も
			// 登らない。実測 2026-09-13、Y=39〜40 を往復して
			// 「Could not climb: nothing to stand on」を繰り返していた。
			if (pillarUpWorks) {
				try {
					await driver.goto(signal, {
						kind: "near",
						position: { x: fx + 0.5, y: fy + 2, z: fz + 0.5 },
						distance: 1,
						dig: true,
					});
				} catch {
					// 次の手へ。
				}
				if (Math.floor(driver.getState().position.y) <= fy) {
					pillarUpWorks = false;
					agent.log("[goto.surface] 柱積みでは上がれない。以降は階段だけで登る");
				}
			}
			if (Math.floor(driver.getState().position.y) <= fy) {
				await digStepUp(agent, signal);
			}

			const nowY = Math.floor(driver.getState().position.y);
			if (nowY <= lastY) {
				stuck++;
				if (stuck >= STUCK_LIMIT) {
					agent.noteStall(
						`goto.surface: at Y=${nowY} there is nothing to stand on and no stairs can be cut; this spot cannot be climbed out of.`,
					);
					return partial() ?? skillResult.fail("Could not climb: nothing to stand on.");
				}
			} else {
				stuck = 0;
				lastY = nowY;
			}
		}

		return partial() ?? skillResult.fail("Could not reach surface.");
	},
});
