/**
 * 生存判断が見てよい世界の姿。
 *
 * ここにあるのは「読み取り専用のただのデータ」だけで、Driver も Agent も
 * 入っていない。理由は2つある。
 *
 * 1. ルールを純粋にするため。判断が driver を触れると、テストにサーバーが
 *    要る。ここまで実機でしか確かめられなかったので、8時間動かして1標本
 *    しか得られず、効いたかどうかが誰にも分からなかった。
 * 2. ルール同士が state を書き換えて合図し合うのを止めるため。反射が15個
 *    あり、27個のフィールドが2箇所以上から書き換えられていた。
 *    実測 2026-09-17、食事・籠り・地上復帰の3つが噛み合って4時間26分
 *    スキルが1つも動かない状態になっている。書けないなら噛み合わない。
 */

export interface Position {
	x: number;
	y: number;
	z: number;
}

export interface SurvivalSnapshot {
	/** この姿を撮った時刻(ms)。ルールは Date.now() を呼ばない。 */
	readonly at: number;
	readonly ready: boolean;
	readonly health: number;
	readonly food: number;
	/** 足元の整数座標。 */
	readonly foot: Position;
	readonly timeOfDay: number;
	readonly night: boolean;

	/** 12マス以内の敵の数。 */
	readonly hostilesNear: number;
	/** 6マス以内の敵の数。殴られている距離。 */
	readonly hostilesClose: number;
	/** 一番近い狩れる動物までの距離。いなければ null。 */
	readonly preyDistance: number | null;

	/** 自分の列の地表までの高さの差。読めなければ null。 */
	readonly depthBelowSurface: number | null;
	/** 頭上に積まっている固いブロックの数。 */
	readonly solidAbove: number;
	/** 四方が塞がっていて歩いて出られない。 */
	readonly boxedIn: boolean;
	/** 蓋があるか穴の中にいる。潜れている状態。 */
	readonly sheltered: boolean;

	readonly armed: boolean;
	readonly armored: boolean;
	/** 手元の材料で武器を作れるか（板材6枚ぶん）。 */
	readonly craftableWeapon: boolean;
	/** いま食べられる物の名前。無ければ null。 */
	readonly edible: string | null;
	/** 焼けば食べ物になる物の名前。無ければ null。 */
	readonly cookable: string | null;
	readonly inventoryCount: number;

	/** 直近の窓(既定10分)で死んだ回数。 */
	readonly recentDeaths: number;
	/** 落とし物の place。無ければ null。 */
	readonly deathPoint: Position | null;
	/** 寝床までの距離。登録が無ければ null。 */
	readonly homeDistance: number | null;
	/**
	 * 掘り荒らされた区域(hazard.ts)の中にいるか。
	 *
	 * 初期リスの周りは自分で掘った穴の集まりで、そこにいる限り落ちるか
	 * 地下に閉じ込められるかしかない。中にいるなら歩いて外へ出る。
	 */
	readonly insideHazard: boolean;
	/** 他の誰かが寝ていて、こちらの就寝を待っている。 */
	readonly sleepRequested: boolean;
	/** 人から頼まれた直後か。生存が懸かっていない限り譲る。 */
	readonly humanRequestFresh: boolean;
}

/** 満腹度がこれ以上あるときだけ体力は自然に戻る。 */
export const REGEN_FOOD = 18;

/**
 * 「待っていれば体力が戻る」状態か。
 *
 * 籠って回復を待ってよいのはこのときだけ。満腹度が足りないまま待つのは
 * ただの待ちぼうけで、実測 2026-09-17 はこれで4時間26分を溶かしている。
 */
export function canRegenerate(s: SurvivalSnapshot): boolean {
	return s.food >= REGEN_FOOD;
}

/** ログに出す1行。数字は判断に使ったものだけを並べる。 */
export function describeSnapshot(s: SurvivalSnapshot): string {
	const parts = [
		`HP${s.health}`,
		`満腹${s.food}`,
		`Y${s.foot.y}`,
		s.night ? "夜" : "昼",
		`敵${s.hostilesNear}`,
	];
	if (s.edible) parts.push(`食料:${s.edible}`);
	else if (s.cookable) parts.push(`生肉:${s.cookable}`);
	else parts.push("食料なし");
	if (s.sheltered) parts.push("潜伏中");
	if (s.boxedIn) parts.push("四方塞がり");
	if (s.insideHazard) parts.push("危険域");
	if (s.depthBelowSurface !== null && s.depthBelowSurface > 0) {
		parts.push(`地表-${s.depthBelowSurface}`);
	}
	return parts.join(" ");
}

/**
 * テストと既定値のための素の姿。
 *
 * テスト側が毎回20個のフィールドを埋めるのは現実的でないので、
 * 「何も起きていない昼の地上」を既定にして、必要な項目だけ上書きさせる。
 */
export function emptySnapshot(over: Partial<SurvivalSnapshot> = {}): SurvivalSnapshot {
	return {
		at: 0,
		ready: true,
		health: 20,
		food: 20,
		foot: { x: 0, y: 64, z: 0 },
		timeOfDay: 1000,
		night: false,
		hostilesNear: 0,
		hostilesClose: 0,
		preyDistance: null,
		depthBelowSurface: 0,
		solidAbove: 0,
		boxedIn: false,
		sheltered: false,
		armed: true,
		armored: true,
		craftableWeapon: false,
		edible: "cooked_beef",
		cookable: null,
		inventoryCount: 1,
		recentDeaths: 0,
		deathPoint: null,
		homeDistance: null,
		insideHazard: false,
		sleepRequested: false,
		humanRequestFresh: false,
		...over,
	};
}
