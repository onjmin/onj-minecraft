/**
 * 生存の成果を測る。
 *
 * これまで記録されていたのは死に方だけだった。設計コメントはどれも
 * 「実測 8時間で43回死に」の形で、何を得たかを数えた場所がどこにも無い。
 * 測っていない量は改善されないので、5日ぶんのログで死亡率は
 * 5.5〜5.9回/時から動いていない一方、コードは1364行から5040行に増えた。
 *
 * ここで数えるのは次の4つ。どれも「積み上がったか」を見るためのもの。
 *   - 死亡間隔        … 生き延びている長さ。伸びなければ何も効いていない
 *   - 食料と装備の保有率 … 生存の鎖が繋がっている時間の割合
 *   - スキルの空振り率  … 成功と報告したが世界が変わらなかった割合
 *   - 最長停滞        … スキルが1つも動かなかった最長の連続時間
 *
 * 最後の1つは 2026-09-17 の4時間26分の停止を直接見つけるための数字で、
 * これが出ていれば、あの日は朝のうちに気づけた。
 */
import fs from "node:fs";
import path from "node:path";
import type { SurvivalSnapshot } from "./snapshot";

/** 1回のサンプリングで加算してよい上限。切断中の空白を混ぜない。 */
const MAX_SAMPLE_MS = 30_000;

export interface SkillStat {
	runs: number;
	ok: number;
	fail: number;
	/** 成功したが、持ち物も位置も変わらなかった回数。 */
	empty: number;
	/** 得た持ち物の総数。 */
	gained: number;
	totalMs: number;
}

export interface MetricsSummary {
	sessionStartedAt: number;
	uptimeMs: number;
	deaths: number;
	deathsPerHour: number;
	medianSurvivalMs: number | null;
	meals: number;
	foodRestored: number;
	haveFoodRatio: number;
	/**
	 * 腐った肉しか持っていない時間も food に数えた割合。
	 *
	 * haveFoodRatio は pickFood が選ぶ物(=反射が自動で食べる物)だけを数える。
	 * 腐肉はそこに入らないので、腐肉だけで夜を越えた時間が 0 と出ていた。
	 * 「狩り→焼きの鎖が通っているか」は haveFoodRatio、「餓えて詰んでいるか」
	 * は anyFoodRatio で見る。
	 */
	anyFoodRatio: number;
	armedRatio: number;
	inventoryRatio: number;
	skillIdleRatio: number;
	longestStallMs: number;
	controlMsByRule: Record<string, number>;
	skills: Record<string, SkillStat>;
}

export class SurvivalMetrics {
	private readonly startedAt: number;
	private readonly savePath: string | null;
	private readonly log: (message: string) => void;
	private readonly now: () => number;

	private lastSampleAt = 0;
	private totalMs = 0;
	private haveFoodMs = 0;
	private anyFoodMs = 0;
	private armedMs = 0;
	private inventoryMs = 0;
	private idleMs = 0;
	private readonly controlMs = new Map<string, number>();

	private deaths: number[] = [];
	private meals = 0;
	private foodRestored = 0;
	private readonly skills = new Map<string, SkillStat>();

	private lastSkillRunAt: number;
	private longestStallMs = 0;
	private lastReportAt: number;

	constructor(
		options: {
			savePath?: string | null;
			log?: (message: string) => void;
			now?: () => number;
		} = {},
	) {
		this.now = options.now ?? (() => Date.now());
		this.startedAt = this.now();
		this.lastSkillRunAt = this.startedAt;
		this.lastReportAt = this.startedAt;
		this.savePath = options.savePath ?? null;
		this.log = options.log ?? (() => {});
	}

	/**
	 * 1周ぶんの状態を記録する。
	 *
	 * @param controlledBy 生存側が担当を握っているならそのルール名。
	 *                     null ならスキル層が動いてよい状態。
	 */
	noteTick(s: SurvivalSnapshot, controlledBy: string | null): void {
		const now = s.at;
		if (this.lastSampleAt === 0) {
			this.lastSampleAt = now;
			return;
		}
		const dt = Math.min(now - this.lastSampleAt, MAX_SAMPLE_MS);
		this.lastSampleAt = now;
		if (dt <= 0) return;

		this.totalMs += dt;
		const haveFood = s.edible !== null || s.cookable !== null;
		if (haveFood) this.haveFoodMs += dt;
		if (haveFood || s.lastResortFood) this.anyFoodMs += dt;
		if (s.armed) this.armedMs += dt;
		if (s.inventoryCount > 0) this.inventoryMs += dt;
		// "(llm)" 付きは LLM が明示的に許した担当。時間の内訳には残すが、
		// 「コードが LLM から奪った時間」ではないので idle(スキル可)に数える。
		if (controlledBy === null || controlledBy.endsWith("(llm)")) this.idleMs += dt;
		if (controlledBy !== null) {
			this.controlMs.set(controlledBy, (this.controlMs.get(controlledBy) ?? 0) + dt);
		}

		const stall = now - this.lastSkillRunAt;
		if (stall > this.longestStallMs) this.longestStallMs = stall;
	}

	/**
	 * 死んだ。記録して、その場で書き出す。
	 *
	 * 書き出しは reportIfDue の中だけにしてはいけない。定期報告の間隔の途中で
	 * 死んで落ちると、その区間が丸ごと消える。しかも消えるのは「死んだ回」に
	 * 偏るので、死亡数だけが抜けて稼働時間は残り、死亡率が実際より低く出る。
	 *
	 * 実測 2026-09-21、ログを grep した死亡は 30 件あるのに metrics-*.json の
	 * 合計は 20 件だった。この 10 件の差で、同じ期間の死亡率が 2.34 回/h とも
	 * 3.50 回/h とも読め、改修の効果判定が有意・非有意の両側に振れた。
	 */
	noteDeath(): void {
		this.deaths.push(this.now());
		this.save();
	}

	noteMeal(foodBefore: number, foodAfter: number): void {
		this.meals++;
		if (foodAfter > foodBefore) this.foodRestored += foodAfter - foodBefore;
	}

	/**
	 * スキルの結果を記録する。
	 *
	 * @param changed 世界が実際に変わったか（持ち物が増えた・位置が動いた）。
	 *                成功を返しても変わっていなければ空振りとして数える。
	 */
	noteSkill(name: string, ok: boolean, changed: boolean, gained: number, ms: number): void {
		const st = this.skills.get(name) ?? {
			runs: 0,
			ok: 0,
			fail: 0,
			empty: 0,
			gained: 0,
			totalMs: 0,
		};
		st.runs++;
		if (ok) st.ok++;
		else st.fail++;
		if (ok && !changed) st.empty++;
		st.gained += gained;
		st.totalMs += ms;
		this.skills.set(name, st);
		this.lastSkillRunAt = this.now();
	}

	/** 死亡の間隔の中央値。2回以上死んでいないと出せない。 */
	private medianSurvival(): number | null {
		if (this.deaths.length < 2) return null;
		const gaps: number[] = [];
		for (let i = 1; i < this.deaths.length; i++) gaps.push(this.deaths[i] - this.deaths[i - 1]);
		gaps.sort((a, b) => a - b);
		const mid = Math.floor(gaps.length / 2);
		return gaps.length % 2 === 1 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
	}

	summary(): MetricsSummary {
		const uptimeMs = this.now() - this.startedAt;
		const hours = uptimeMs / 3_600_000;
		const ratio = (ms: number) => (this.totalMs > 0 ? ms / this.totalMs : 0);
		return {
			sessionStartedAt: this.startedAt,
			uptimeMs,
			deaths: this.deaths.length,
			deathsPerHour: hours > 0 ? this.deaths.length / hours : 0,
			medianSurvivalMs: this.medianSurvival(),
			meals: this.meals,
			foodRestored: this.foodRestored,
			haveFoodRatio: ratio(this.haveFoodMs),
			anyFoodRatio: ratio(this.anyFoodMs),
			armedRatio: ratio(this.armedMs),
			inventoryRatio: ratio(this.inventoryMs),
			skillIdleRatio: ratio(this.idleMs),
			longestStallMs: this.longestStallMs,
			controlMsByRule: Object.fromEntries(this.controlMs),
			skills: Object.fromEntries(this.skills),
		};
	}

	/** ログに出す1行。数字の意味が分かる並びにする。 */
	summaryLine(): string {
		const m = this.summary();
		const pct = (r: number) => `${Math.round(r * 100)}%`;
		const min = (ms: number) => `${(ms / 60_000).toFixed(1)}分`;
		let emptyRuns = 0;
		let runs = 0;
		for (const st of Object.values(m.skills)) {
			runs += st.runs;
			emptyRuns += st.empty;
		}
		return [
			`[計測] 稼働 ${(m.uptimeMs / 3_600_000).toFixed(1)}h`,
			`死亡 ${m.deaths}(${m.deathsPerHour.toFixed(1)}/h`,
			m.medianSurvivalMs !== null ? `間隔中央値 ${min(m.medianSurvivalMs)})` : "間隔 —)",
			`食事 ${m.meals}`,
			`食料保有 ${pct(m.haveFoodRatio)}(腐肉込み ${pct(m.anyFoodRatio)})`,
			`武器保有 ${pct(m.armedRatio)}`,
			`持ち物あり ${pct(m.inventoryRatio)}`,
			`スキル可 ${pct(m.skillIdleRatio)}`,
			`空振り ${runs > 0 ? pct(emptyRuns / runs) : "—"}`,
			`最長停滞 ${min(m.longestStallMs)}`,
		].join(" ");
	}

	/**
	 * 一定間隔で1行だけ出す。呼び出し側は毎周呼んでよい。
	 * 出したときだけ true。
	 */
	reportIfDue(intervalMs: number): boolean {
		const now = this.now();
		if (now - this.lastReportAt < intervalMs) return false;
		this.lastReportAt = now;
		this.log(this.summaryLine());
		this.save();
		return true;
	}

	save(): void {
		if (!this.savePath) return;
		try {
			fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
			fs.writeFileSync(this.savePath, JSON.stringify(this.summary(), null, 2), "utf8");
		} catch {
			// 計測が本体を止めてよい理由は無い。
		}
	}
}
