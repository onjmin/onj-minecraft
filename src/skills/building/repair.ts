import type { MinecraftAgent } from "../../core/agent";
import type { Position } from "../../core/driver/types";
import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * 掘った跡を埋める。引数なしなら自分の台帳、座標を渡せばその一帯。
 *
 * 経緯を書いておく。長いあいだ、このボットには「掘る」側の処理しか無かった。
 * 残っているログだけで破壊2300件以上に対して設置0件。初期リス周辺が
 * 穴だらけになり、他のプレイヤーから「管理人の追加したbotのせいで
 * めちゃくちゃ荒れてる」と苦情が出た。
 *
 * 穴が空いた理由は悪意ではなく、生存のための反射が積み重なった結果だった。
 * 潜って隠れる、四方を塞がれたので横を掘って出る、地上へ掘り上がる。
 * どれも単体では正しいが、戻す処理が無いので跡だけが残り続ける。
 */

/** 1回の実行で埋めるマスの数。長く占有せず、何周かに分けて返す。 */
const MAX_PER_RUN = 24;
/** 一帯を直すときに数える半径。サイドカーの持っている範囲に収める。 */
const DEFAULT_AREA_RADIUS = 12;
const MAX_AREA_RADIUS = 24;
/**
 * 「本来の地面の高さ」を決めるのに使う分位点。
 *
 * 荒れた一帯では平均も中央値も穴に引きずられて下がる。掘られていない
 * 周囲の地面が本来の高さなので、高い方に寄せて見る。
 */
/**
 * 「本来の地面」を決めるのに使う分位点。
 *
 * 一帯の平均的な高さを人に見せるための目安であって、穴の判定には使わない。
 * 判定に使ってはいけない理由は findHoleColumns に書いてある。
 */
const INTACT_PERCENTILE = 0.7;
/**
 * 周り8列の中央値からこれだけ落ち込んでいたら「穴」と見なす。
 *
 * 大域的な基準ではなく局所比較なので、数段でも「不自然な落ち込み」を指す。
 * それでも保守側に倒す。一度荒らしている以上、直しに行って別の物を壊す方が
 * 高くつく。実測(2026-09-12、初期リス半径20)では、4段の落ち込みは小さな崖や
 * 川岸でもありえたが、7〜12段のものは明らかに掘られた跡だった。
 *
 * 広い窪地は、内側の列も周りが一緒に低いので最初は引っかからない。縁から
 * 埋めていくと次の環が引っかかるので、何周かに分けて外側から詰まっていく。
 * それでよい。一度に全部やろうとしない。
 */
const HOLE_DEPTH_THRESHOLD = 5;
/**
 * 人工物からこの距離内の列は触らない。
 *
 * 他人の建物の出入口、階段、井戸、地下室への降り口を「穴」と読んで
 * 塞いだら、埋め戻しのつもりで新しい荒らしをすることになる。
 */
const MANMADE_KEEPOUT = 6;

/** 列の地表。surfaceScan が返す形。 */
export type SurfaceColumn = { x: number; z: number; y: number; name: string; open: number };

/**
 * 中央寄りの「本来の高さ」を求める。
 *
 * 検証用に外へ出している。テストが本番と別実装になると、確かめたことに
 * ならない。実際に置く前の空振り確認(bedrock-repair-check)がこれを使う。
 */
export function intactSurfaceY(ys: number[]): number {
	const sorted = ys.slice().sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * INTACT_PERCENTILE));
	return sorted[idx];
}

/**
 * 「本来の地面」より低く沈んでいる列＝穴を選ぶ。
 *
 * 検証用に外へ出している。実際にブロックを置く前に、何を穴と見なすのかを
 * 読み取りだけで確かめられるようにするため。判定を間違えたまま本番の世界に
 * 置くと、修復のつもりで新しい荒らしになる。
 */
export function findHoleColumns(
	columns: SurfaceColumn[],
	center: { x: number; z: number },
	radius: number,
	_groundY: number,
	landmarks: { position: Position }[],
): (SurfaceColumn & { fillY: number })[] {
	// 列を座標で引けるようにする。
	const at = new Map<string, SurfaceColumn>();
	for (const c of columns) at.set(`${c.x},${c.z}`, c);

	const out: (SurfaceColumn & { fillY: number })[] = [];
	for (const c of columns) {
		if (Math.hypot(c.x - center.x, c.z - center.z) > radius) continue;

		// 周り8列の中央値と比べる。
		//
		// 一帯の分位点(大域的な基準)と比べてはいけない。自然地形は数ブロック
		// 単位で常に上下するので、緩い斜面・くぼ地・岸辺がまるごと「穴」に
		// なる。実測 2026-09-12、初期リス周辺で1678列中154列が穴と判定され、
		// その大半が基準より3〜5段低いだけの自然地形だった。あれを埋めたら
		// 修復ではなく「地形を平らに均す」という別の荒らしになる。
		//
		// 掘られた穴は「近隣より急に落ち込んでいる」もので、斜面は「近隣も
		// 一緒に下がっている」もの。局所比較なら区別がつく。
		const neighbours: number[] = [];
		for (const dx of [-1, 0, 1]) {
			for (const dz of [-1, 0, 1]) {
				if (dx === 0 && dz === 0) continue;
				const n = at.get(`${c.x + dx},${c.z + dz}`);
				if (n) neighbours.push(n.y);
			}
		}
		// 周りが読めていない列は判断しない。読めないものを穴と決めつけない。
		if (neighbours.length < 5) continue;

		neighbours.sort((a, b) => a - b);
		const localGround = neighbours[Math.floor(neighbours.length / 2)];
		if (c.y >= localGround - HOLE_DEPTH_THRESHOLD) continue;

		// 他人の建物の出入口・階段・井戸・地下室への降り口を「穴」と読んで
		// 塞いだら、埋め戻しのつもりで新しい荒らしになる。
		if (
			landmarks.some((l) => Math.hypot(l.position.x - c.x, l.position.z - c.z) < MANMADE_KEEPOUT)
		) {
			continue;
		}

		// 蓋をする高さは周りの地面に合わせる。一帯の平均に合わせると、
		// 斜面の途中で段差ができる。
		out.push({ ...c, fillY: localGround });
	}

	// 浅い穴から埋める。周りに地面が残っている列ほど置きやすく、
	// 置いたブロックが次の足場になる。
	return out.sort((a, b) => b.y - a.y);
}

/** 台帳に載っている跡を埋める（引数なしのとき）。 */
async function repairLedger(
	agent: MinecraftAgent,
	signal: AbortSignal,
): Promise<SkillResponse<{ filled: number; left: number }>> {
	const { driver } = agent;
	// 掘りたては外す。登るために刻んだ階段を自分で塞いだら上がれなくなる。
	const holes = agent.getFillableHoles();
	if (holes.length === 0) {
		const owed = agent.getDugHoles().length;
		return skillResult.ok(
			owed > 0
				? `Nothing to fill right now (${owed} holes are too fresh — I may still need them to get around).`
				: "No holes of mine left to fill.",
			{ filled: 0, left: owed },
		);
	}
	if (driver.inventory.items().length === 0) {
		return skillResult.fail(
			`I still owe ${holes.length} holes, but I am carrying nothing to fill them with. Gather dirt or cobblestone first.`,
		);
	}

	agent.log(`[奉公] 台帳の埋め戻しに行く。残り ${holes.length} 件`);

	let filled = 0;
	for (const hole of holes.slice(0, MAX_PER_RUN)) {
		if (signal.aborted) break;

		const now = driver.world.blockAt(hole.position);
		if (now !== null && now.name !== "air") {
			// もう埋まっている。誰かが直したか、水や砂が流れ込んだ。
			agent.clearDugHole(hole.position);
			continue;
		}
		try {
			// 穴そのものではなく隣に立つ。上に乗ると自分が落ちる。
			await driver.goto(signal, { kind: "near", position: hole.position, distance: 2 });
		} catch {
			// 届かない跡は後回し。台帳からは消さない。
			continue;
		}
		if (await agent.fillHoleAt(signal, hole.position, hole.name)) filled++;
	}

	const left = agent.getDugHoles().length;
	if (filled === 0) {
		return skillResult.fail(
			`Could not fill any holes this time (${left} still open). I may be out of blocks or unable to reach them.`,
		);
	}
	return skillResult.ok(`Filled ${filled} of the holes I dug (${left} still open).`, {
		filled,
		left,
	});
}

/**
 * 一帯の穴を、周りの地面の高さに合わせて塞ぐ。
 *
 * 体積を丸ごと埋めることはしない。48ブロック掘り抜かれた穴を底から埋めると
 * 数万ブロック要り、その材料を得るために別の場所を掘ることになる。それでは
 * 荒らす場所が移るだけ。人がやるのと同じく、周りの地面の高さで蓋をして、
 * 歩ける・落ちない状態に戻すところまでをやる。
 *
 * 端から内側へ順に置く。置いたブロックが次の足場になるので、宙に浮いた
 * マスでも縁から詰めていける。
 */
async function repairArea(
	agent: MinecraftAgent,
	signal: AbortSignal,
	center: { x: number; z: number },
	radius: number,
): Promise<SkillResponse<{ filled: number; left: number }>> {
	const { driver } = agent;

	const columns = await driver.world.surfaceScan(radius);
	if (columns.length === 0) {
		return skillResult.fail("Could not read the terrain around here yet.");
	}

	const groundY = intactSurfaceY(columns.map((c) => c.y));
	const landmarks = agent.getKnownLandmarks();
	const holes = findHoleColumns(columns, center, radius, groundY, landmarks);

	if (holes.length === 0) {
		return skillResult.ok(`The ground around here is level (surface Y=${groundY}).`, {
			filled: 0,
			left: 0,
		});
	}

	agent.log(`[奉公] 一帯の穴を塞ぐ。地面の高さ Y=${groundY}、穴になっている列 ${holes.length}`);

	let filled = 0;
	for (const hole of holes) {
		if (signal.aborted) break;
		if (filled >= MAX_PER_RUN) break;
		if (driver.inventory.items().length === 0) break;

		// 蓋をする高さは列ごと。周りの地面に合わせる。
		const target: Position = { x: hole.x, y: hole.fillY, z: hole.z };
		const at = driver.world.blockAt(target);
		if (at !== null && at.name !== "air") continue;

		try {
			await driver.goto(signal, { kind: "near", position: target, distance: 3 });
		} catch {
			// 届かない列は次の周に回す。
			continue;
		}
		if (await agent.fillHoleAt(signal, target, "dirt")) filled++;
	}

	const left = Math.max(0, holes.length - filled);
	if (filled === 0) {
		return skillResult.fail(
			`Could not close any of the ${holes.length} holes here. I may be out of blocks or unable to reach them.`,
		);
	}
	return skillResult.ok(`Closed ${filled} holes in the ground here (${left} to go).`, {
		filled,
		left,
	});
}

export const buildingRepairSkill = createSkill<
	{ x?: number; z?: number; radius?: number },
	{ filled: number; left: number }
>({
	name: "building.repair",
	description:
		"Fills in holes in the ground with blocks you are carrying. With no arguments it fills the holes you yourself dug. Given x/z (and optional radius) it levels the wrecked ground around that spot back to the surrounding height. You are a guest in someone else's world and players have complained that the spawn area is full of holes — this is how you make up for it. It never digs to get filler, so gather dirt or cobblestone first.",
	inputSchema: {
		x: { type: "number", description: "Optional: X of the area to level out" },
		z: { type: "number", description: "Optional: Z of the area to level out" },
		radius: { type: "number", description: "Optional: how far around x/z to repair (default 12)" },
	} as any,
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ filled: number; left: number }>> => {
		const x = Number(args?.x);
		const z = Number(args?.z);
		const wantsArea = Number.isFinite(x) && Number.isFinite(z);

		if (!wantsArea) return repairLedger(agent, signal);

		const radius = Number.isFinite(Number(args?.radius))
			? Math.min(MAX_AREA_RADIUS, Math.max(2, Math.floor(Number(args?.radius))))
			: DEFAULT_AREA_RADIUS;

		if (agent.driver.inventory.items().length === 0) {
			return skillResult.fail(
				"I have nothing to fill with. Gather dirt or cobblestone first, then ask me again.",
			);
		}

		// 現場まで行かないと地形が読めない。サイドカーが持っているのは
		// 自分の周りのチャンクだけ。
		try {
			await agent.driver.goto(signal, { kind: "xz", x, z, distance: 4 });
		} catch {
			// 近くまで来ていれば読める。届かなくても続ける。
		}
		return repairArea(agent, signal, { x, z }, radius);
	},
});
