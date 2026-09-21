/**
 * 自分のベッドを作って置き、リスポーン地点をここへ移す。
 *
 * 2026-09-20 の実測(8.6時間・死亡30回)で、死亡の 14 回は初期リスの
 * クレーター(自分が掘り抜いた穴、底に水が溜まっている)の中だった。復帰地点が
 * その真上(6, 73, 66)にあり、生き返った数秒後には Y=40 前後の穴底にいる。
 * そこから登り直すのに 1 回の生存時間 14 分の大半を使い、夜に丸腰で死んで
 * また穴へ戻る。危険域を避ける処理は積んであるが、避けたい場所に毎回生まれ
 * 直すので効かない。
 *
 * チートは使わない(管理者コマンドは不可逆なので本人が OFF のまま解決すると
 * 決めた)。ゲーム内で復帰地点を動かす手段はベッドだけ。羊毛 3(同じ色) +
 * 板 3 で作れる。羊は 2026-09-19 の修正で倒せるようになった。
 *
 * これは LLM が選ぶスキルで、反射ではない。どこに置くかは LLM が決める。
 * 危険域の中と地下は置いても意味が無いので、そこだけ断って理由を返す。
 * 統合版はベッドを叩いた時点で復帰地点が移る。夜でなくてよい。
 */
import type { MinecraftAgent } from "../../core/agent";
import { ensureCraftingTable, ensurePlanks, tryPlaceBlock } from "../crafting/util";
import { createSkill, type SkillResponse, skillResult } from "../types";

/** 統合版は "bed" ひとつ。Java版は色ごとの名前。 */
export const BED_BLOCK_NAMES = [
	"bed",
	"white_bed",
	"orange_bed",
	"magenta_bed",
	"light_blue_bed",
	"yellow_bed",
	"lime_bed",
	"pink_bed",
	"gray_bed",
	"light_gray_bed",
	"cyan_bed",
	"purple_bed",
	"blue_bed",
	"brown_bed",
	"green_bed",
	"red_bed",
	"black_bed",
];

/** ベッド1台に要る羊毛の数。同じ色でそろえる必要がある。 */
export const BED_WOOL_COUNT = 3;
/** ベッド1台に要る板の数。種類は問わない。 */
export const BED_PLANK_COUNT = 3;
/** この深さより下は「地下」。穴の底に置いても復帰した瞬間に埋まる。 */
const MAX_DEPTH_FOR_BED = 3;

/** 色ごとの羊毛の数。統合版は white_wool のように色付きの名前で来る。 */
export function woolByColor(items: { name: string; count: number }[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const i of items) {
		if (i.name === "wool" || i.name.endsWith("_wool")) {
			out.set(i.name, (out.get(i.name) ?? 0) + i.count);
		}
	}
	return out;
}

/** 3枚そろっている色。無ければ null。 */
export function pickBedWool(items: { name: string; count: number }[]): string | null {
	for (const [name, n] of woolByColor(items)) {
		if (n >= BED_WOOL_COUNT) return name;
	}
	return null;
}

/** 羊毛の合計。プロンプトに「あと何枚」を出すため。 */
export function totalWool(items: { name: string; count: number }[]): number {
	let n = 0;
	for (const v of woolByColor(items).values()) n += v;
	return n;
}

async function depthHere(agent: MinecraftAgent): Promise<number | null> {
	const state = agent.driver.getState();
	if (!state.isReady) return null;
	const myX = Math.floor(state.position.x);
	const myY = Math.floor(state.position.y);
	const myZ = Math.floor(state.position.z);
	try {
		const columns = await agent.driver.world.surfaceScan(2);
		const mine =
			columns.find((c) => c.x === myX && c.z === myZ) ??
			columns
				.slice()
				.sort((a, b) => Math.hypot(a.x - myX, a.z - myZ) - Math.hypot(b.x - myX, b.z - myZ))[0];
		return mine ? mine.y - myY : null;
	} catch {
		return null;
	}
}

export const buildBedSkill = createSkill<void, { position: { x: number; y: number; z: number } }>({
	name: "building.bed",
	description:
		"Crafts a bed from 3 wool of one color + 3 planks, places it where you stand, and uses it so you RESPAWN HERE instead of at the old respawn point. Do this on the surface, outside any dug-out hazard zone, once you have the wool (sheep drop 1 wool each). Also lets you sleep at night.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ position: { x: number; y: number; z: number } }>> => {
		const { driver } = agent;
		if (signal.aborted) return skillResult.fail("Aborted");

		const pos = driver.getState().position;
		if (agent.isInHazard(pos)) {
			return skillResult.fail(
				"You are inside a dug-out hazard zone; a bed here would just respawn you back into the crater. Walk out of the zone first (SITUATION gives the exit), then place the bed.",
			);
		}
		const depth = await depthHere(agent);
		if (depth !== null && depth > MAX_DEPTH_FOR_BED) {
			return skillResult.fail(
				`You are underground (surface is ${depth} blocks up). Place the bed on the surface, or you will respawn buried.`,
			);
		}

		// 既に自分のベッドが目の前にあるなら、作らずに登録し直すだけ。
		const existing = driver.world.findBlock(BED_BLOCK_NAMES, 3);
		if (existing) {
			// 置ける物を持ったまま叩くと設置になる。道具に持ち替える。
			await agent.holdToolForInteraction();
			const r = await driver.useBed(existing.position);
			if (r === "none") {
				return skillResult.fail(
					`Used the bed at (${existing.position.x}, ${existing.position.y}, ${existing.position.z}) but the server did not acknowledge it; the respawn point did NOT move. Stand right next to the bed and try again.`,
				);
			}
			agent.noteOwnBed(existing.position);
			return skillResult.ok(
				`Respawn point set at the bed at (${existing.position.x}, ${existing.position.y}, ${existing.position.z}).`,
				{ position: existing.position },
			);
		}

		let bedItem = driver.inventory.items().find((i) => i.name === "bed" || i.name.endsWith("_bed"));
		if (!bedItem) {
			const items = driver.inventory.items();
			const wool = pickBedWool(items);
			if (!wool) {
				const have = totalWool(items);
				return skillResult.fail(
					`A bed needs ${BED_WOOL_COUNT} wool of ONE color; you have ${have} wool in total (${
						[...woolByColor(items)].map(([n, c]) => `${n} x${c}`).join(", ") || "none"
					}). Hunt sheep (1 wool each) or find wool.`,
				);
			}
			if (!(await ensurePlanks(agent, BED_PLANK_COUNT))) {
				return skillResult.fail(
					`A bed needs ${BED_PLANK_COUNT} planks and you have no wood to make them. Gather a log first.`,
				);
			}
			const table = await ensureCraftingTable(agent);
			if (!table) {
				return skillResult.fail(
					"A bed is a 3x3 recipe and needs a crafting table (4 planks); could not get one placed here.",
				);
			}
			if (!driver.canCraft("bed", table.position)) {
				return skillResult.fail(
					`The server offers no bed recipe for ${wool} + planks here (recipe table lacks it).`,
				);
			}
			try {
				await driver.craft("bed", 1, table.position);
			} catch (err) {
				return skillResult.fail(
					`Crafting the bed was refused: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			bedItem = driver.inventory.items().find((i) => i.name === "bed" || i.name.endsWith("_bed"));
			if (!bedItem) {
				return skillResult.fail(
					"Crafted a bed but it did not show up in the inventory (inventory copy is stale). Try again in a moment.",
				);
			}
		}

		// ベッドは2マス使う。置ける場所は tryPlaceBlock が候補を順に試し、
		// 塞がっている向きはサーバーが捨てるので次の候補へ回る。
		const placed = await tryPlaceBlock(agent, bedItem.name, "bed");
		const block = placed ?? driver.world.findBlock(BED_BLOCK_NAMES, 4);
		if (!block) {
			return skillResult.fail(
				"Could not place the bed here: no flat 2-block spot next to you. Move to open flat ground and try again.",
			);
		}

		// 叩いて復帰地点を移す。昼は「今は寝られません」と返るが地点は移る。
		// 直前までベッドを手に持っているので、道具に持ち替えてから叩く。
		let ack: "set" | "ack" | "none" = "none";
		try {
			await agent.holdToolForInteraction();
			ack = await driver.useBed(block.position);
			if (ack === "none") {
				await agent.holdToolForInteraction();
				ack = await driver.useBed(block.position);
			}
		} catch (err) {
			agent.log(`[building.bed] ベッドを叩けなかった: ${err}`);
		}
		if (ack === "none") {
			return skillResult.fail(
				`Placed the bed at (${block.position.x}, ${block.position.y}, ${block.position.z}) but the server did not acknowledge using it, so the respawn point did NOT move yet. Call building.bed again while standing next to it.`,
			);
		}
		agent.noteOwnBed(block.position);
		return skillResult.ok(
			`Placed your own bed at (${block.position.x}, ${block.position.y}, ${block.position.z}) and set it as your respawn point. From now on you respawn here, not in the crater.`,
			{ position: block.position },
		);
	},
});
