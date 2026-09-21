/**
 * 世界の姿(SurvivalSnapshot)を、思考(LLM)が判断に使える文に直す。
 *
 * ここはコードが判断してよい唯一の場所ではなく、コードが「解釈して伝える」
 * 場所である。判断そのもの(地上へ出るか、食料を先にするか)はしない。
 * 以前はこれらの事実を見て「surface ルールが担当」「secure_food が担当」と
 * コード側が決めていた。決めるのは LLM で、ここはその材料を欠かさず渡す。
 *
 * 数字は生のまま出さず、意味を添える。座標と体力だけ並べても、24B の
 * モデルは「地表まで20マス下にいる」を読み取れない。実測、Y=53 で
 * 「作業台まで10ブロック」と読み違えて穴へ戻り続けた。
 */
import { BURIED_THICKNESS } from "./rules";
import type { SurvivalSnapshot } from "./snapshot";
import { REGEN_FOOD } from "./snapshot";

/** 統合版の1日は 24000 tick、1 tick は 50ms。 */
const TICKS_PER_DAY = 24000;
/** 夜の始まり。agent.ts の NIGHT_START_TICK と同じ値(明るさは 12500 過ぎから落ちる)。 */
const NIGHT_START = 12500;
/**
 * 夜の終わり。日の出(0)の後も undead が燃え尽きるまで 1200 tick は「夜」に数える
 * (agent.ts の DAWN_SAFE_TICK と同じ値)。
 */
const DAWN_SAFE_TICK = 1200;
const MS_PER_TICK = 50;

export interface SituationExtras {
	/** 危険域の中にいるとき、歩いて出る先。 */
	hazardExit?: { x: number; z: number } | null;
	/** 落とし物の場所が、さっき殺された場所の近くか。 */
	lootNearRecentDeath?: boolean;
	/** 直近の死のうち、夜に地上で死んだ数と総数。夜に歩く判断の材料。 */
	nightSurfaceDeaths?: { night: number; total: number };
	/** 未踏の遠い候補と、これまでの最大到達距離。範囲が狭いことを見せる。 */
	frontier?: {
		target: { x: number; z: number };
		visitsNear: number;
		farthest: number;
		distance: number;
	} | null;
	/** 直近の高さの推移。地下で行き来しているだけかを見せる。 */
	heightTrend?: { minutes: number; from: number; to: number; low: number; high: number } | null;
	/** 腐った肉の所持数。食べれば +4、80% で短い空腹効果。 */
	rottenFlesh?: number;
	/** 近くに落ちている物。"rotten_flesh(3m)" の形。 */
	droppedItems?: string[];
	/** 羊毛の所持数(色を問わず合計)。ベッドは同じ色3枚。 */
	wool?: number;
	/** 同じ色の羊毛が3枚そろっているか。 */
	bedWoolReady?: boolean;
	/**
	 * 復帰地点(登録したベッド、無ければ直前に生まれ直した場所)が危険域の
	 * 中か。死ぬたびに穴底から始まる、という事実は行動の優先順位を変える。
	 */
	respawnInHazard?: boolean;
}

function minutes(ticks: number): string {
	const m = (ticks * MS_PER_TICK) / 60_000;
	return m < 1 ? "less than a minute" : `about ${Math.round(m)} minutes`;
}

/** 夜までの残り、または夜明けまでの残りを tick で返す。 */
export function ticksUntilNightChange(timeOfDay: number): number {
	const t = ((timeOfDay % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
	if (t >= NIGHT_START) return TICKS_PER_DAY - t + DAWN_SAFE_TICK;
	if (t < DAWN_SAFE_TICK) return DAWN_SAFE_TICK - t;
	return NIGHT_START - t;
}

export function describeSituation(s: SurvivalSnapshot, x: SituationExtras = {}): string[] {
	const lines: string[] = [];

	// 時刻。夜は「あと何分で明けるか」、昼は「あと何分で暮れるか」。
	// 夜に地下から掘り上がるか朝を待つかは、この数字で決まる。
	const left = ticksUntilNightChange(s.timeOfDay);
	if (s.night && s.timeOfDay % TICKS_PER_DAY < NIGHT_START) {
		// 日は出たが、undead はまだ燃え尽きていない。
		lines.push(
			`The sun is rising (time ${s.timeOfDay}) but skeletons and zombies from the night are still around and burning; they keep shooting for another ${minutes(left)}. Stay sheltered until then.`,
		);
	} else if (s.night) {
		lines.push(
			`It is NIGHT (time ${s.timeOfDay}). Hostile mobs spawn in the dark. Dawn in ${minutes(left)}.`,
		);
	} else {
		lines.push(`It is daytime (time ${s.timeOfDay}). Night falls in ${minutes(left)}.`);
	}

	// 高さ。地下にいる限り、木も動物も無い。
	if (s.depthBelowSurface !== null && s.depthBelowSurface > 0) {
		lines.push(
			`You are UNDERGROUND: the surface of your column is ${s.depthBelowSurface} blocks above you (you at Y=${s.foot.y}, surface at Y=${s.foot.y + s.depthBelowSurface}). There is no wood or animals down here.`,
		);
	} else if (s.depthBelowSurface === 0) {
		lines.push(`You are on the surface (Y=${s.foot.y}).`);
	} else if (s.solidAbove >= BURIED_THICKNESS) {
		// 地表までの距離が読めなくても、頭上が厚ければ地下である。実測
		// 2026-09-19 のローカル採点で、深さが読めず「5 solid blocks above」
		// だけが出て、LLM は石室の中から狩りを選んだ。
		lines.push(
			`You are UNDERGROUND: at least ${s.solidAbove} solid blocks are stacked above your head and the sky is not visible. Nothing to gather or hunt down here until you dig up.`,
		);
	}
	if (s.solidAbove > 0 && (s.depthBelowSurface === null || s.depthBelowSurface > 0)) {
		lines.push(`${s.solidAbove} solid blocks are stacked directly above your head.`);
	}
	if (s.boxedIn) lines.push("You are boxed in: no open block to walk to on any side.");
	if (s.sheltered) lines.push("You are in a covered hole (sheltered).");

	// 危険域。出口の座標を添える。「出ろ」だけでは goto.coords の引数が決まらない。
	if (s.insideHazard) {
		const exit = x.hazardExit
			? ` Nearest way out on the surface: x=${x.hazardExit.x}, z=${x.hazardExit.z} — call goto.coords(x: ${x.hazardExit.x}, z: ${x.hazardExit.z}) with no y.`
			: "";
		lines.push(
			`You are INSIDE a dug-out hazard zone (cratered ground full of vertical shafts). Falling and getting buried happen here.${exit}`,
		);
	}

	// 敵。数だけでなく、殴られる距離かどうか。
	if (s.hostilesClose > 0) {
		lines.push(`${s.hostilesClose} hostile mob(s) within 6 blocks — you are in melee range.`);
	} else if (s.hostilesNear > 0) {
		lines.push(`${s.hostilesNear} hostile mob(s) within 12 blocks.`);
	}

	// 体力と満腹度。自然回復の条件は統合版固有なので明記する。
	if (s.health <= 8) {
		lines.push(`Health is LOW (${s.health}/20).`);
	}
	if (s.food < REGEN_FOOD) {
		lines.push(
			`Hunger ${s.food}/20: health does NOT regenerate below ${REGEN_FOOD}. Eating is what restores health.`,
		);
	}

	// 食料の鎖。どこで切れているかを言う。
	if (s.edible) {
		lines.push(`You carry food you can eat now: ${s.edible}.`);
	} else if (s.cookable) {
		// 焼く手段(かまど・精錬)は 2026-09-20 に外した。70 時間でかまどを一度も
		// 確保できていない。生で食べるのが唯一の道なので、そう言う。
		lines.push(`You carry raw ${s.cookable}. You have no way to cook it.`);
		// 事実(回復量とリスク)だけ渡す。
		lines.push(
			s.cookable === "chicken"
				? "Raw chicken can be eaten as-is via survival.eat: +2 hunger, 30% chance of a short Hunger effect (not lethal). Cooked chicken gives +6."
				: `Raw ${s.cookable} can be eaten as-is via survival.eat for roughly half the hunger of cooked.`,
		);
	} else if ((x.rottenFlesh ?? 0) > 0) {
		// 腐った肉は食べ物に数えていない(反射の eat は避ける)が、食べれば戻る。
		// ゾンビが落とし、夜明けに日光で焼けたゾンビの分が地面に残る(オーナー
		// の知識 2026-09-20)。判断は LLM。
		lines.push(
			`You have no proper food, but you carry ${x.rottenFlesh} rotten flesh: eating it via survival.eat(item: rotten_flesh) restores +4 hunger, with an 80% chance of a short Hunger effect (not lethal).`,
		);
	} else {
		lines.push("You have no food and nothing to cook.");
		if (s.preyDistance !== null) {
			lines.push(`Nearest huntable animal is ${Math.round(s.preyDistance)} blocks away.`);
		} else {
			// 「いない」も事実。これが無いと、動物が見えないまま狩りを選ぶ
			// (実測 2026-09-20、collecting.hunting 33回中32回が「いない」で失敗)。
			lines.push("No huntable animal is in sight; hunting requires moving somewhere else first.");
		}
	}

	// 高さの推移。地下にいるときだけ。「登っている」と「行き来している」は
	// 数字を見なければ区別できない(実測 2026-09-20 23:00、12分間 Y=18〜24 を往復)。
	const trend = x.heightTrend;
	if (trend && (s.depthBelowSurface ?? 0) > 3) {
		const net = trend.to - trend.from;
		lines.push(
			`Over the last ${trend.minutes} minutes your height went from Y=${trend.from} to Y=${trend.to} (net ${net >= 0 ? "+" : ""}${net}, ranging Y=${trend.low}..${trend.high}). Cutting stairs gains about 1 block per 40 seconds only while goto.surface keeps running; every switch to another skill drops what it was doing.`,
		);
	}

	// 未踏の方向。地上で昼のときだけ(夜や地下では行けない)。
	// 実測 2026-09-20〜21、位置の 87% が初期リスから 100 ブロック以内で、
	// 200 を超えた記録は無い。羊も村も、回っている範囲の外にある。
	const fr = x.frontier;
	if (fr && !s.night && (s.depthBelowSurface ?? 0) <= 3) {
		lines.push(
			`You have never been more than ${fr.farthest} blocks from spawn; everything within that circle has already been searched (no sheep). The least-visited far area is around x=${fr.target.x}, z=${fr.target.z} (${fr.distance} blocks from you${fr.visitsNear === 0 ? ", never visited" : ""}). Reaching it takes several goto.coords(x: ${fr.target.x}, z: ${fr.target.z}) calls in a row (each walks up to ~40 blocks); exploring.explore_land also heads that way when nothing else pulls it.`,
		);
	}

	// 落ちている物。統合版は近づけば拾える。
	if (x.droppedItems && x.droppedItems.length > 0) {
		lines.push(
			`Items lying on the ground nearby: ${x.droppedItems.slice(0, 6).join(", ")}. collecting.pickup walks over and picks them up.`,
		);
	}
	// 夜明け直後は、日光に当たったゾンビが燃えて腐った肉を落とす。
	if (s.timeOfDay % TICKS_PER_DAY < 1500 && (s.depthBelowSurface ?? 0) <= 2) {
		lines.push(
			"It is just after dawn: zombies caught in sunlight burn and drop rotten flesh where they stood. Rotten flesh is edible (+4 hunger).",
		);
	}

	// 復帰地点。死ぬたびにどこから始まるかは、他の全部の前提になる。
	if (x.respawnInHazard) {
		lines.push(
			"Your RESPAWN POINT is inside the dug-out hazard zone: every death puts you back at the bottom of the crater, and you spend the next life climbing out. A bed placed on the surface outside the zone moves it (building.bed: 3 wool of one color + 3 planks).",
		);
		if (x.bedWoolReady) {
			lines.push("You already carry enough wool for a bed.");
		} else if ((x.wool ?? 0) > 0) {
			lines.push(`You carry ${x.wool} wool; a bed needs 3 of one color. Sheep drop 1 wool each.`);
		}
	} else if ((x.wool ?? 0) > 0) {
		lines.push(
			`You carry ${x.wool} wool (a bed needs 3 of one color)${x.bedWoolReady ? " — enough for a bed" : ""}.`,
		);
	}

	// 装備。
	if (s.armed) {
		lines.push("You are armed (sword or axe in inventory).");
	} else if (s.craftableWeapon) {
		lines.push("You are UNARMED but carry enough wood/planks to craft a wooden sword.");
	} else {
		lines.push("You are UNARMED and have no wood to craft a sword.");
	}

	// 落とし物。取りに行く判断の材料。
	if (s.deathPoint) {
		const dx = s.deathPoint.x - s.foot.x;
		const dy = s.deathPoint.y - s.foot.y;
		const dz = s.deathPoint.z - s.foot.z;
		const horizontal = Math.round(Math.hypot(dx, dz));
		const vertical =
			dy > 1
				? `, ${Math.round(dy)} blocks above you`
				: dy < -1
					? `, ${Math.round(-dy)} blocks below you`
					: "";
		const warn = x.lootNearRecentDeath ? " You were killed near there very recently." : "";
		lines.push(
			`Your dropped items lie at (${Math.round(s.deathPoint.x)}, ${Math.round(s.deathPoint.y)}, ${Math.round(s.deathPoint.z)}), ${horizontal} blocks away horizontally${vertical}. They vanish about 5 minutes after death.${warn}`,
		);
	}

	if (s.recentDeaths > 0) {
		lines.push(`You died ${s.recentDeaths} time(s) in the last 10 minutes.`);
	}
	// 夜に地上で死んだ回数。夜に歩くかどうかは LLM が決めるが、自分の死因の
	// 偏りは知っていないと決められない。剣を持っていても書く(剣を持って夜に
	// 探索して殺された実測がある)。
	const nsd = x.nightSurfaceDeaths;
	if (nsd && nsd.night > 0) {
		lines.push(
			`Of your last ${nsd.total} death(s), ${nsd.night} happened at NIGHT on the SURFACE (mobs and skeleton arrows)${
				s.night ? " — it is night now" : ""
			}.${s.armed ? " A wooden sword has not changed that." : ""}`,
		);
	}

	return lines;
}
