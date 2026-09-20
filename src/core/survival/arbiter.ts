/**
 * 反射ルールの裁定者。
 *
 * 「誰が担当するか」と「いつまで掴んでよいか」を、ここ1箇所だけが決める。
 * ルールは他を黙らせる手段を持たず、共有フィールドで合図もしない。
 * 結果として、ルールを1つ足すときに確かめるのは「順位」だけになる。
 *
 * 保持には必ず期限がある。期限の無い保持を1つでも許すと、そこで止まった
 * ときに誰も気づけない。実測 2026-09-17、籠りの保持に出口が無く、
 * 07:10:20 から 11:36 までの4時間26分、スキルが1つも動かなかった。
 * ログに残っていたのは60秒ごとの同じ1行と、実行されない思考だけだった。
 *
 * 行動が失敗したら、担当を手放して冷却に入り、理由を LLM に報告する。
 * 以前は失敗しても前提(when)が変わらない限り同じルールが担当を取り続け、
 * 「生肉はあるがかまどが無い」を3秒おきに43回繰り返した。その間 LLM は
 * 何も知らされず、丸石を集めるという当然の判断を出す機会が無かった。
 * 失敗は裁定者が握りつぶすものではなく、上へ返すものである。
 */

import type { SurvivalActions, SurvivalRule } from "./rules";
import { SURVIVAL_RULES } from "./rules";
import type { SurvivalSnapshot } from "./snapshot";

export type DecisionKind =
	/** 掴み続ける。 */
	| "continue"
	/** 新しく担当を取る。 */
	| "take"
	/** 前提が消えたので手放す。 */
	| "release"
	/** 上限に達したので取り上げる。 */
	| "expire"
	/** 行動が失敗したので手放し、LLM に判断を返す。 */
	| "yield"
	/** 誰も担当しない。スキル層が動いてよい。 */
	| "idle";

export interface ArbiterDecision {
	readonly kind: DecisionKind;
	readonly rule: SurvivalRule | null;
	/** expire/release/yield のとき、手放したルールの名前。 */
	readonly released: string | null;
	readonly why: string;
	/** いま掴んでいる担当が続いている時間(ms)。 */
	readonly heldMs: number;
}

export interface ArbiterOptions {
	readonly rules?: readonly SurvivalRule[];
	/** 保持がこれを超えたら警告を出す。止まっていることを外から見えるようにする。 */
	readonly warnAfterMs?: number;
	readonly log?: (message: string) => void;
	/**
	 * LLM への報告。担当の取得・取り上げ・失敗のたびに1行(英語)渡す。
	 *
	 * 渡された側(ReflexLog)が次の思考プロンプトに載せる。ここが無いと、
	 * 反射が何をしたかを LLM は知らないまま次の行動を選ぶことになる。
	 */
	readonly report?: (line: string) => void;
	/**
	 * 行動を実行したあとの時刻。冷却の起点に使う。
	 *
	 * select は snapshot.at だけを見る(純粋)が、tick は行動を走らせるので
	 * 実時間が経つ。40秒かけて失敗した行動の冷却を snapshot.at から数えると、
	 * 60秒の冷却が実質20秒になる。テストでは差し替える。
	 */
	readonly now?: () => number;
}

export class SurvivalArbiter {
	private readonly rules: readonly SurvivalRule[];
	private readonly warnAfterMs: number;
	private readonly log: (message: string) => void;
	private readonly report: (line: string) => void;
	private readonly now: () => number;
	private held: { rule: SurvivalRule; since: number; until: number } | null = null;
	private readonly cooldownUntil = new Map<string, number>();
	private lastWarnAt = 0;

	constructor(options: ArbiterOptions = {}) {
		this.rules = options.rules ?? SURVIVAL_RULES;
		this.warnAfterMs = options.warnAfterMs ?? 5 * 60_000;
		this.log = options.log ?? (() => {});
		this.report = options.report ?? (() => {});
		this.now = options.now ?? (() => Date.now());
	}

	/** いま担当しているルール名。誰も担当していなければ null。 */
	get holding(): string | null {
		return this.held?.rule.name ?? null;
	}

	/**
	 * 担当を決める。
	 *
	 * 世界のコピーだけを見て決めるので、サーバーもボットも要らずに試せる。
	 * 時刻は snapshot.at を使う。Date.now() は呼ばない。
	 */
	select(s: SurvivalSnapshot): ArbiterDecision {
		const now = s.at;

		if (this.held) {
			const { rule, since, until } = this.held;
			const heldMs = now - since;
			const capped = rule.capWhen ? rule.capWhen(s) : true;
			if (capped && now >= until) {
				this.held = null;
				this.cooldownUntil.set(rule.name, now + rule.cooldownMs);
				const held =
					heldMs >= 60_000 ? `${Math.round(heldMs / 60_000)}分` : `${Math.round(heldMs / 1_000)}秒`;
				const decision: ArbiterDecision = {
					kind: "expire",
					rule: null,
					released: rule.name,
					why: `${rule.name} を ${held} 掴んだままなので取り上げる`,
					heldMs,
				};
				this.report(
					`${rule.report(s)} It held control for ${Math.round(heldMs / 1_000)}s and was forced to stop; it will not run again for ${Math.round(rule.cooldownMs / 1_000)}s.`,
				);
				// 取り上げた直後も、下位のルールには担当の機会を与える。
				const next = this.take(s, rule.name);
				return next ?? decision;
			}
			if (rule.when(s)) {
				this.warnIfStuck(rule.name, heldMs, now);
				return { kind: "continue", rule, released: null, why: rule.why(s), heldMs };
			}
			this.held = null;
			const next = this.take(s, null);
			return (
				next ?? {
					kind: "release",
					rule: null,
					released: rule.name,
					why: `${rule.name} の前提が消えた`,
					heldMs,
				}
			);
		}

		const next = this.take(s, null);
		return next ?? { kind: "idle", rule: null, released: null, why: "", heldMs: 0 };
	}

	/** 担当を取れるルールを上から探す。取れたら保持を始める。 */
	private take(s: SurvivalSnapshot, excluded: string | null): ArbiterDecision | null {
		for (const rule of this.rules) {
			if (rule.name === excluded) continue;
			if ((this.cooldownUntil.get(rule.name) ?? 0) > s.at) continue;
			if (!rule.when(s)) continue;
			this.held = { rule, since: s.at, until: s.at + rule.holdMs };
			this.report(rule.report(s));
			return { kind: "take", rule, released: excluded, why: rule.why(s), heldMs: 0 };
		}
		return null;
	}

	/**
	 * 担当を決めて、その行動を1回実行する。
	 *
	 * 戻り値の rule が null でない間、スキル層は動かない。null のときは
	 * 反射側に用が無いということなので、思考が選んだスキルが走る。
	 *
	 * 行動が失敗(例外)したら、担当を手放して冷却に入り、理由を報告する
	 * (kind: "yield")。同じ前提で同じ行動を繰り返しても同じ結果になる。
	 * 次に何をするかは LLM が決める。
	 */
	async tick(
		s: SurvivalSnapshot,
		actions: SurvivalActions,
		signal: AbortSignal,
	): Promise<ArbiterDecision> {
		const decision = this.select(s);
		if (decision.kind === "expire" || decision.kind === "release") {
			if (decision.released) this.log(`[反射] ${decision.why}`);
		}
		const rule = decision.rule;
		if (!rule) return decision;
		if (decision.kind === "take") this.log(`[反射:${rule.name}] ${decision.why}`);
		try {
			await rule.run(actions, signal);
		} catch (err) {
			if (signal.aborted) return decision;
			const reason = err instanceof Error ? err.message : String(err);
			return this.yieldAfterFailure(s, rule, reason);
		}
		return decision;
	}

	/** 行動が失敗した。手放して冷却し、LLM に理由を渡す。 */
	private yieldAfterFailure(
		s: SurvivalSnapshot,
		rule: SurvivalRule,
		reason: string,
	): ArbiterDecision {
		const heldMs = this.held ? this.now() - this.held.since : 0;
		this.held = null;
		this.cooldownUntil.set(rule.name, this.now() + rule.cooldownMs);
		this.log(`[反射:${rule.name}] 失敗したので手放す: ${reason}`);
		this.report(
			`${rule.report(s)} It FAILED: ${reason} The reflex stands down for ${Math.round(rule.cooldownMs / 1_000)}s; deciding what to do about this is now up to you.`,
		);
		return {
			kind: "yield",
			rule: null,
			released: rule.name,
			why: `${rule.name} が失敗した: ${reason}`,
			heldMs,
		};
	}

	/** 担当を強制的に手放す。死亡や再接続のように、状況が作り直されたとき。 */
	reset(): void {
		this.held = null;
		this.cooldownUntil.clear();
		this.lastWarnAt = 0;
	}

	private warnIfStuck(name: string, heldMs: number, now: number): void {
		if (heldMs < this.warnAfterMs) return;
		if (now - this.lastWarnAt < this.warnAfterMs) return;
		this.lastWarnAt = now;
		this.log(`[反射] ${name} が ${Math.round(heldMs / 60_000)}分 担当を握り続けている`);
	}
}
