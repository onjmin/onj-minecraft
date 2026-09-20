/**
 * 反射のルール表。上にあるものほど優先される。
 *
 * ここに置いてよいのは「LLM の判断を待つと手遅れになるもの」だけである。
 * 状況を読んで何をするか決めるのは LLM の仕事で、この表はその代わりを
 * しない。2026-09-19 までは、地上へ出る・食料を確保する・武器を作る・
 * 危険域から出る・落とし物を取りに行く、という分単位の計画がここに並び、
 * LLM が選んだ行動を止め、失敗しても LLM に理由を返さなかった。3週間半で
 * 判断コードは3倍に増え、死亡率は動かなかった。そこで計画をここから外し、
 * 事実は situation.ts が LLM に渡し、選ぶのは LLM に戻した。
 *
 * ルールを1つ足そうとしたら、まず問うこと。
 *   - LLM はこの状況を見えていたか。見えていないなら、渡すべきは事実(situation)。
 *   - 見えていて選べなかったなら、足りないのはスキルか、その説明。
 *   - 秒未満で判断が要らず、待てば死ぬ。それだけがここに入る資格を持つ。
 *
 * 各ルールは
 *   - when: 純粋な前提条件。世界のコピーだけを見る。副作用も Date.now() も無い
 *   - run:  行動。他のルールを黙らせる手段は持たない
 *   - report: LLM に何をしたか報告する1行(英語)
 * だけを持つ。誰が担当するかは裁定者(arbiter.ts)が1箇所で決め、掴み続けて
 * よい時間も裁定者が握る。行動が失敗したら、裁定者が担当を手放して理由を
 * LLM に渡す。同じ失敗を繰り返すのは、ここの仕事ではない。
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
/** これを下回ったら、割の悪い手段でも食料を取りに行く。 */
export const STARVING_FOOD = envNum("STARVING_FOOD", 6);
/** 狩りに出てよい距離。これより遠い獲物は追わない。 */
export const HUNT_RANGE = envNum("HUNT_RANGE", 32);

/** ルールが行動するときに使える操作。Agent が実装する。 */
export interface SurvivalActions {
	log(message: string): void;
	/** 持ち物から食べる。食べられたら true。 */
	eat(signal: AbortSignal): Promise<boolean>;
	/** 寝床へ戻るか、その場に潜る。 */
	shelter(signal: AbortSignal): Promise<void>;
	/** 四方を塞がれているとき、1マス掘って出口を作る。 */
	escapeBoxedIn(signal: AbortSignal): Promise<void>;
	/** ベッドに入る。入れたら true。 */
	sleep(signal: AbortSignal): Promise<boolean>;
}

export interface SurvivalRule {
	/** 表示と計測に使う名前。 */
	readonly name: string;
	/** なぜ担当したのかを1行で。ログにはこれだけが出る。 */
	readonly why: (s: SurvivalSnapshot) => string;
	/**
	 * LLM への報告(英語)。担当を取ったとき・取り上げられたときに渡る。
	 *
	 * 思考プロンプトは英語だけで書く決まりなので、日本語の why とは別に持つ。
	 * 混ぜると出力まで日本語に引きずられる。
	 */
	readonly report: (s: SurvivalSnapshot) => string;
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
 * 待てないなら、食べに行くのが先で、それは LLM が選ぶ。
 */
export function isHurtAndCanWait(s: SurvivalSnapshot): boolean {
	return s.health <= SHELTER_HEALTH && canRegenerate(s) && s.hostilesNear > 0;
}

/** 埋まっているか。situation が LLM に伝えるときにも使う。 */
export function isBuried(s: SurvivalSnapshot): boolean {
	return (
		s.solidAbove >= BURIED_THICKNESS ||
		(s.depthBelowSurface !== null && s.depthBelowSurface > DEEP_UNDERGROUND_GAP)
	);
}

/**
 * 優先順位表。上から順に、前提が成立した最初の1つだけが担当する。
 *
 * 4本しかないのは意図である。並べ替えるときは、その理由をここに書くこと。
 */
export const SURVIVAL_RULES: readonly SurvivalRule[] = [
	{
		// 出口が無いと他の何も始まらない。掘るのは一瞬で、判断は要らない。
		//
		// 夜に自分で潜って塞がっているのは「閉じ込められている」ではない。
		// ここを見落とすと、籠りが担当を取る前(再接続や死亡直後)に、
		// 自分で塞いだ蓋を掘り返して夜の地上へ出てしまう。
		name: "escape_boxed_in",
		why: () => "四方を塞がれている。掘って出口を作る",
		report: () => "Reflex escape_boxed_in: you were boxed in, dug one block to make an exit.",
		when: (s) => s.ready && s.health > 0 && s.boxedIn && !(s.night && s.sheltered),
		holdMs: envNum("ESCAPE_HOLD_MS", 10_000),
		cooldownMs: envNum("ESCAPE_COOLDOWN_MS", 10_000),
		run: (a, signal) => a.escapeBoxedIn(signal),
	},
	{
		// 持っている物を食べるのは判断ではない。敵が至近にいるときはやらない。
		// 食事中は動けない。
		name: "eat",
		why: (s) => `満腹度 ${s.food}。${s.edible} を食べる`,
		report: (s) => `Reflex eat: hunger was ${s.food}, ate ${s.edible}.`,
		when: (s) =>
			s.ready &&
			s.health > 0 &&
			s.food < EAT_BELOW_FOOD &&
			s.edible !== null &&
			s.hostilesClose === 0,
		holdMs: 15_000,
		cooldownMs: 5_000,
		run: async (a, signal) => {
			// 食べたつもりで増えていないのは失敗。裁定者が手放して LLM に返す。
			if (!(await a.eat(signal))) throw new Error("ate nothing (hunger did not rise).");
		},
	},
	{
		// 統合版は全員が寝ないと夜を飛ばせない。起きているのがボット1体でも
		// 他の人が朝を迎えられないので、こちらの都合より優先する。
		// 相手を待たせる時間を考えると LLM の1周(30秒)は長い。
		name: "sleep",
		why: () => "誰かが寝ている。ベッドへ向かう",
		report: () => "Reflex sleep: another player went to bed, so you headed for a bed too.",
		when: (s) => s.ready && s.health > 0 && s.sleepRequested,
		holdMs: 60_000,
		cooldownMs: 30_000,
		run: async (a, signal) => {
			if (!(await a.sleep(signal))) throw new Error("no reachable bed to sleep in.");
		},
	},
	{
		// 夜の地上を丸腰で歩かない。実測、これを入れる前は8分で13回死に、
		// 大半が death.attack.mob だった。
		//
		// これは4本の中で唯一、分単位で担当を握るルールである。だから
		// LLM が切れるようにしてある。出力の Hide 欄で断られたら(shelterDeclined)、
		// 瀕死か死に続けているときを除いて担当を取らない。判断は LLM、ここは
		// LLM が何も言わないときの既定にすぎない。
		//
		// 地下深くでは潜らない。潜る動作は足元を掘るので、地下では
		// 「隠れる」ではなく「深くなる」でしかない。地下から出るかどうかは
		// LLM が situation を読んで決める。
		name: "shelter",
		why: (s) =>
			isDying(s)
				? `短時間に${s.recentDeaths}回死んだ。退いて止める`
				: isHurtAndCanWait(s)
					? `体力 ${s.health}。退いて回復を待つ`
					: "夜で装備が無い。退いてやり過ごす",
		report: (s) =>
			isDying(s)
				? `Reflex shelter: you died ${s.recentDeaths} times in a short span, so you hid and waited.`
				: isHurtAndCanWait(s)
					? `Reflex shelter: health ${s.health}, hid to regenerate.`
					: "Reflex shelter: night and unarmed, hid underground until morning.",
		when: (s) => {
			if (!s.ready || s.health <= 0) return false;
			if (s.depthBelowSurface !== null && s.depthBelowSurface > DEEP_UNDERGROUND_GAP) return false;
			const hurt = isHurtAndCanWait(s);
			const dying = isDying(s);
			if (!s.night && !hurt && !dying) return false;
			// 頼まれた直後は出る。瀕死のときだけは、頼まれごとより先に死ぬので譲らない。
			if (s.humanRequestFresh && !hurt) return false;
			// LLM が籠らないと決めたなら従う。瀕死・死に続けのときだけは譲らない。
			if (s.shelterDeclined && !hurt && !dying) return false;
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
];
