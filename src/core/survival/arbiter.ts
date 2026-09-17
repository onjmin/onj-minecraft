/**
 * 生存ルールの裁定者。
 *
 * 「誰が担当するか」と「いつまで掴んでよいか」を、ここ1箇所だけが決める。
 * ルールは他を黙らせる手段を持たず、共有フィールドで合図もしない。
 * 結果として、ルールを1つ足すときに確かめるのは「順位」だけになる。
 *
 * 保持には必ず期限がある。期限の無い保持を1つでも許すと、そこで止まった
 * ときに誰も気づけない。実測 2026-09-17、籠りの保持に出口が無く、
 * 07:10:20 から 11:36 までの4時間26分、スキルが1つも動かなかった。
 * ログに残っていたのは60秒ごとの同じ1行と、実行されない思考だけだった。
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
	/** 誰も担当しない。スキル層が動いてよい。 */
	| "idle";

export interface ArbiterDecision {
	readonly kind: DecisionKind;
	readonly rule: SurvivalRule | null;
	/** expire/release のとき、手放したルールの名前。 */
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
}

export class SurvivalArbiter {
	private readonly rules: readonly SurvivalRule[];
	private readonly warnAfterMs: number;
	private readonly log: (message: string) => void;
	private held: { rule: SurvivalRule; since: number; until: number } | null = null;
	private readonly cooldownUntil = new Map<string, number>();
	private lastWarnAt = 0;

	constructor(options: ArbiterOptions = {}) {
		this.rules = options.rules ?? SURVIVAL_RULES;
		this.warnAfterMs = options.warnAfterMs ?? 5 * 60_000;
		this.log = options.log ?? (() => {});
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
			return { kind: "take", rule, released: excluded, why: rule.why(s), heldMs: 0 };
		}
		return null;
	}

	/**
	 * 担当を決めて、その行動を1回実行する。
	 *
	 * 戻り値の controlled が true の間、スキル層は動かない。false のときは
	 * 生存側に用が無いということなので、思考が選んだスキルが走る。
	 */
	async tick(
		s: SurvivalSnapshot,
		actions: SurvivalActions,
		signal: AbortSignal,
	): Promise<ArbiterDecision> {
		const decision = this.select(s);
		if (decision.kind === "expire" || decision.kind === "release") {
			if (decision.released) this.log(`[生存] ${decision.why}`);
		}
		const rule = decision.rule;
		if (!rule) return decision;
		if (decision.kind === "take") this.log(`[生存:${rule.name}] ${decision.why}`);
		try {
			await rule.run(actions, signal);
		} catch (err) {
			if (!signal.aborted) {
				this.log(`[生存:${rule.name}] 失敗: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return decision;
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
		this.log(`[生存] ${name} が ${Math.round(heldMs / 60_000)}分 担当を握り続けている`);
	}
}
