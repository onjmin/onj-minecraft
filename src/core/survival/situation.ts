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
const NIGHT_START = 13000;
const NIGHT_END = 23000;
const MS_PER_TICK = 50;

export interface SituationExtras {
	/** 危険域の中にいるとき、歩いて出る先。 */
	hazardExit?: { x: number; z: number } | null;
	/** 落とし物の場所が、さっき殺された場所の近くか。 */
	lootNearRecentDeath?: boolean;
	/** かまどを持っているか。生肉を焼けるかどうかの材料。 */
	hasFurnace?: boolean;
	/** ツルハシを持っているか。丸石を得られるかどうかの材料。 */
	hasPickaxe?: boolean;
	/** 丸石の所持数。かまどは8個で作れる。 */
	cobblestone?: number;
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
	if (t >= NIGHT_START && t <= NIGHT_END) return NIGHT_END - t;
	return t < NIGHT_START ? NIGHT_START - t : NIGHT_START + TICKS_PER_DAY - t;
}

export function describeSituation(s: SurvivalSnapshot, x: SituationExtras = {}): string[] {
	const lines: string[] = [];

	// 時刻。夜は「あと何分で明けるか」、昼は「あと何分で暮れるか」。
	// 夜に地下から掘り上がるか朝を待つかは、この数字で決まる。
	const left = ticksUntilNightChange(s.timeOfDay);
	if (s.night) {
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
			? ` Nearest way out on the surface: walk to (${x.hazardExit.x}, ${x.hazardExit.z}).`
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
		if (x.hasFurnace) {
			lines.push(`You carry raw ${s.cookable} and a furnace: cooking it makes it edible.`);
		} else {
			const cobble = x.cobblestone ?? 0;
			const pick = x.hasPickaxe
				? "you have a pickaxe"
				: "you have NO pickaxe, so you cannot mine stone yet";
			lines.push(
				`You carry raw ${s.cookable} but NO furnace. A furnace needs 8 cobblestone (you have ${cobble}; ${pick}) and a crafting table.`,
			);
		}
		// 生のまま食べるかどうかは判断。事実(回復量とリスク)だけ渡す。
		lines.push(
			s.cookable === "chicken"
				? "Raw chicken can be eaten as-is via survival.eat: +2 hunger, 30% chance of a short Hunger effect (not lethal). Cooked chicken gives +6."
				: `Raw ${s.cookable} can be eaten as-is via survival.eat for roughly half the hunger of cooked.`,
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
			`Your dropped items lie at (${s.deathPoint.x}, ${s.deathPoint.y}, ${s.deathPoint.z}), ${horizontal} blocks away horizontally${vertical}. They vanish about 5 minutes after death.${warn}`,
		);
	}

	if (s.recentDeaths > 0) {
		lines.push(`You died ${s.recentDeaths} time(s) in the last 10 minutes.`);
	}

	return lines;
}
