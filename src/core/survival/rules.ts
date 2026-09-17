/**
 * 生存のルール表。上にあるものほど優先される。
 *
 * これまで生存判断は15個の反射メソッドとして reflexSurvival に並んでいた。
 * それぞれが「自分が担当したら true を返して他を黙らせる」拒否権を持ち、
 * `sheltering` や `currentTaskName` のような共有フィールドを書き換えて
 * 隣に合図していた。1つ足すたびに、既存14個が作りうる状態すべてとの
 * 噛み合わせを確かめる必要があり、しかもその確認は本番8時間で1標本しか
 * 得られなかった。増える速さが確かめる速さを上回るので、5日間で死亡率は
 * 5.5〜5.9回/時から動いていない。
 *
 * ここでは各ルールが
 *   - when: 純粋な前提条件。世界のコピーだけを見る。副作用も Date.now() も無い
 *   - run:  行動。他のルールを黙らせる手段は持たない
 * だけを持つ。誰が担当するかは裁定者(arbiter.ts)が1箇所で決め、掴み続けて
 * よい時間も裁定者が握る。ルールを1つ足すコストは「表に1行入れて、その順位が
 * 正しいかを見る」だけになり、既存との組み合わせを数える必要が無くなる。
 */
import { EAT_BELOW_FOOD } from "../driver/food";
import { envNum } from "../utils/env";
import { canRegenerate, type SurvivalSnapshot } from "./snapshot";

export { EAT_BELOW_FOOD };

/** この体力を下回ったら、昼でも退いて回復を待つ。 */
export const SHELTER_HEALTH = envNum("SHELTER_HEALTH", 8);
/** この回数を短い窓で死んだら「死に続けている」。 */
export const DEATH_STORM_LIMIT = envNum("DEATH_STORM_LIMIT", 3);
/** 自分の列の地表がこれより上なら「地下深く」。 */
export const DEEP_UNDERGROUND_GAP = envNum("DEEP_UNDERGROUND_GAP", 5);
/** 頭上にこれだけ固いものが積まっていたら「埋まっている」。 */
export const BURIED_THICKNESS = envNum("BURIED_THICKNESS", 4);
/** 狩りに出てよい距離。これより遠い獲物は追わない。 */
export const HUNT_RANGE = envNum("HUNT_RANGE", 32);

/** ルールが行動するときに使える操作。Agent が実装する。 */
export interface SurvivalActions {
	log(message: string): void;
	/** 持ち物から食べる。食べられたら true。 */
	eat(signal: AbortSignal): Promise<boolean>;
	/** 狩る・焼く。食料が増えたら true。 */
	secureFood(signal: AbortSignal): Promise<boolean>;
	/** 寝床へ戻るか、その場に潜る。 */
	shelter(signal: AbortSignal): Promise<void>;
	/** 地上へ1歩ぶん近づく。 */
	goToSurface(signal: AbortSignal): Promise<void>;
	/** 四方を塞がれているとき、1マス掘って出口を作る。 */
	escapeBoxedIn(signal: AbortSignal): Promise<void>;
	/** 落とし物を取りに行く。 */
	recoverLoot(signal: AbortSignal): Promise<void>;
	/** ベッドに入る。入れたら true。 */
	sleep(signal: AbortSignal): Promise<boolean>;
	/** 手元の材料で武器を作る。 */
	armSelf(signal: AbortSignal): Promise<void>;
}

export interface SurvivalRule {
	/** 表示と計測に使う名前。 */
	readonly name: string;
	/** なぜ担当したのかを1行で。ログにはこれだけが出る。 */
	readonly why: (s: SurvivalSnapshot) => string;
	/** 前提条件。純粋であること（driver も Date.now() も触らない）。 */
	readonly when: (s: SurvivalSnapshot) => boolean;
	/**
	 * 掴み続けてよい上限(ms)。裁定者が強制的に取り上げる。
	 *
	 * 上限のない保持を1つでも許すと、そこで止まったときに誰も気づけない。
	 * 実測 2026-09-17、籠りの保持に出口条件が無く4時間26分スキルが
	 * 動かなかった。ログに残っていたのは60秒ごとの同じ1行だけ。
	 */
	readonly holdMs: number;
	/** 取り上げられた後、再び掴めるまでの時間(ms)。 */
	readonly cooldownMs: number;
	/**
	 * 上限を効かせてよい状況。既定は「常に」。
	 *
	 * 夜の籠りだけは例外で、明けるまでは取り上げない。夜に穴から出すのは
	 * 上限で守りたかったもの(止まらないこと)より確実に高くつく。夜の籠りは
	 * when が朝に false になるので、上限が無くても必ず終わる。
	 */
	readonly capWhen?: (s: SurvivalSnapshot) => boolean;
	readonly run: (actions: SurvivalActions, signal: AbortSignal) => Promise<void>;
}

/** 装備が揃っているか。片方でもあれば夜歩きに耐える。 */
function equipped(s: SurvivalSnapshot): boolean {
	return s.armed || s.armored;
}

/** 死に続けているか。 */
export function isDying(s: SurvivalSnapshot): boolean {
	return s.recentDeaths >= DEATH_STORM_LIMIT;
}

/**
 * 傷ついていて、待てば戻る状態か。
 *
 * 満腹度が足りないときを外すのが要点。統合版の自然回復は満腹度18以上で
 * しか起きないので、それ未満で「回復を待つ」のは待ちぼうけにしかならない。
 * 待てないなら、待つより食べに行く方が近い(secureFood の担当になる)。
 */
export function isHurtAndCanWait(s: SurvivalSnapshot): boolean {
	return s.health <= SHELTER_HEALTH && canRegenerate(s) && s.hostilesNear > 0;
}

/** 埋まっているか。 */
export function isBuried(s: SurvivalSnapshot): boolean {
	return (
		s.solidAbove >= BURIED_THICKNESS ||
		(s.depthBelowSurface !== null && s.depthBelowSurface > DEEP_UNDERGROUND_GAP)
	);
}

/**
 * 優先順位表。上から順に、前提が成立した最初の1つだけが担当する。
 *
 * 並べ替えるときは、その理由をここに書くこと。順位そのものが仕様になる。
 */
export const SURVIVAL_RULES: readonly SurvivalRule[] = [
	{
		// 出口が無いと他のルールは全部空振りする。食べるにも狩るにも
		// 地上へ出るにも、まず動ける形にする必要がある。
		//
		// 潜っている最中(籠りが担当している間)は裁定者が他を走らせないので、
		// 自分で塞いだ蓋をここが掘り返すことはない。以前はこれが
		// 「潜る→掘り返す→また潜る」の往復になり、一晩で86回殺されていた。
		name: "escape_boxed_in",
		why: () => "四方を塞がれている。掘って出口を作る",
		// 夜に自分で潜って塞がっているのは「閉じ込められている」ではない。
		// ここを見落とすと、籠りが担当を取る前(再接続や死亡直後)に、
		// 自分で塞いだ蓋を掘り返して夜の地上へ出てしまう。
		when: (s) => s.ready && s.health > 0 && s.boxedIn && !(s.night && s.sheltered),
		// 短く持つ。掘るのは一瞬なので、長く握ってもスキル層を止めるだけ。
		holdMs: envNum("ESCAPE_HOLD_MS", 10_000),
		cooldownMs: envNum("ESCAPE_COOLDOWN_MS", 10_000),
		run: (a, signal) => a.escapeBoxedIn(signal),
	},
	{
		// 食事は籠りより先。満腹度が足りなければ籠っても体力は戻らない。
		// 敵が至近にいるときはやらない。食事中は動けない。
		name: "eat",
		why: (s) => `満腹度 ${s.food}。${s.edible} を食べる`,
		when: (s) =>
			s.ready &&
			s.health > 0 &&
			s.food < EAT_BELOW_FOOD &&
			s.edible !== null &&
			s.hostilesClose === 0,
		holdMs: 15_000,
		cooldownMs: 5_000,
		run: async (a, signal) => {
			await a.eat(signal);
		},
	},
	{
		// 統合版は全員が寝ないと夜を飛ばせない。起きているのがボット1体でも
		// 他の人が朝を迎えられないので、こちらの都合より優先する。
		name: "sleep",
		why: () => "誰かが寝ている。ベッドへ向かう",
		when: (s) => s.ready && s.health > 0 && s.sleepRequested,
		holdMs: 60_000,
		cooldownMs: 30_000,
		run: async (a, signal) => {
			await a.sleep(signal);
		},
	},
	{
		// 夜の地上を丸腰で歩かない。実測、これを入れる前は8分で13回死に、
		// 大半が death.attack.mob だった。
		//
		// 待ってよいのは「待てば戻る」ときだけ。満腹度が足りないときは
		// isHurtAndCanWait が false になり、下の secure_food が担当する。
		//
		// 地下深くでは潜らない。潜る動作は足元を掘るので、地下では
		// 「隠れる」ではなく「深くなる」でしかない。実測 2026-09-16、
		// 8時間で43回死に、一度も地表(Y=55〜66)に出ていない。
		name: "shelter",
		why: (s) =>
			isDying(s)
				? `短時間に${s.recentDeaths}回死んだ。退いて止める`
				: isHurtAndCanWait(s)
					? `体力 ${s.health}。退いて回復を待つ`
					: "夜で装備が無い。退いてやり過ごす",
		when: (s) => {
			if (!s.ready || s.health <= 0) return false;
			if (s.depthBelowSurface !== null && s.depthBelowSurface > DEEP_UNDERGROUND_GAP) return false;
			const hurt = isHurtAndCanWait(s);
			const dying = isDying(s);
			if (!s.night && !hurt && !dying) return false;
			// 頼まれた直後は出る。瀕死のときだけは、頼まれごとより先に死ぬので譲らない。
			if (s.humanRequestFresh && !hurt) return false;
			// 装備が揃っていて無傷なら、夜でも歩ける。
			if (!hurt && !dying && equipped(s)) return false;
			return true;
		},
		// 統合版の夜は実時間で約8分。上限はそれを1周できる長さにし、
		// 明ければ when が false になって自然に手放す。
		holdMs: envNum("SHELTER_HOLD_MAX_MS", 10 * 60_000),
		cooldownMs: envNum("SHELTER_COOLDOWN_MS", 3 * 60_000),
		// 昼だけ上限を効かせる。夜は朝まで掴んでよい。
		capWhen: (s) => !s.night,
		run: (a, signal) => a.shelter(signal),
	},
	{
		// 食料の確保。ここが生存の鎖の1本目で、ずっと抜けていた。
		//
		// 食料 → 自然回復 → 夜を越す → 持ち物を保つ → 道具、という鎖の
		// 最初が繋がっていないため、何を積んでも死ぬたびに全部落ちて
		// 毎回ゼロから始まっていた。全ログ通算で食事は23回しかない。
		//
		// 夜は出ない。ただし満腹度0で敵もいないなら、待っていても
		// 餓死するだけなので近くの獲物には行く。
		name: "secure_food",
		why: (s) => `満腹度 ${s.food} で食べ物が無い。${s.cookable ? "焼く" : "狩る"}`,
		when: (s) => {
			if (!s.ready || s.health <= 0) return false;
			if (s.food >= EAT_BELOW_FOOD) return false;
			if (s.edible !== null) return false; // 食べる方が先
			// 焼けば食べられるなら、獲物がいなくても仕事がある。
			if (s.cookable !== null) return !s.night || s.sheltered;
			if (s.preyDistance === null || s.preyDistance > HUNT_RANGE) return false;
			if (s.night) return s.food <= 6 && s.hostilesNear === 0;
			return true;
		},
		holdMs: envNum("SECURE_FOOD_HOLD_MS", 3 * 60_000),
		cooldownMs: envNum("SECURE_FOOD_COOLDOWN_MS", 60_000),
		run: async (a, signal) => {
			await a.secureFood(signal);
		},
	},
	{
		// 地上へ戻るのは判断ではなく前提。木も動物も地上にあるので、
		// 地下にいる限り何も進まない。
		name: "surface",
		why: (s) => `地表は ${s.depthBelowSurface ?? "?"} マス上。先に地上へ出る`,
		when: (s) => s.ready && s.health > 0 && isBuried(s),
		holdMs: envNum("SURFACE_HOLD_MS", 3 * 60_000),
		cooldownMs: envNum("SURFACE_COOLDOWN_MS", 60_000),
		run: (a, signal) => a.goToSurface(signal),
	},
	{
		// 落とし物の回収。安全なときだけ。
		name: "recover_loot",
		why: () => "落とし物を取りに戻る",
		when: (s) =>
			s.ready &&
			s.health > 0 &&
			s.deathPoint !== null &&
			!s.night &&
			s.hostilesNear === 0 &&
			!isDying(s),
		holdMs: envNum("RECOVER_HOLD_MS", 2 * 60_000),
		cooldownMs: envNum("RECOVER_COOLDOWN_MS", 60_000),
		run: (a, signal) => a.recoverLoot(signal),
	},
	{
		// 丸腰なら剣。材料があるのに素手で探索を続けていた実測がある。
		// 敵が近いときはやらない。クラフト中は無防備で、作りかけで
		// 殺されると材料ごと落とす。
		name: "arm",
		why: () => "丸腰。手元の材料で武器を作る",
		when: (s) =>
			s.ready && s.health > 0 && !s.armed && s.craftableWeapon && s.hostilesNear === 0 && !s.night,
		holdMs: 60_000,
		cooldownMs: 60_000,
		run: (a, signal) => a.armSelf(signal),
	},
];
