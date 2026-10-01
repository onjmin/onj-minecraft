/**
 * スキルごとの成否と「世界が変わったか」の記録。
 *
 * 「成功と報告するが何も得ていない」スキルを、実績で落とすために持つ。
 * 本番では collecting.stone が「10個収集」と返しながら持ち物が空だった。
 * ああいうものを人が気付くまで選ばせ続けるのは無駄が大きい。
 *
 * 2026-10-01 に agent.ts から切り出した。中身は動かしていない。
 */
export type SkillReliability = { tried: number; rate: number; progressed: number };

export class SkillStats {
	private stats = new Map<string, { ok: number; fail: number; progressed: number }>();

	recordOutcome(name: string, ok: boolean): void {
		const st = this.stats.get(name) ?? { ok: 0, fail: 0, progressed: 0 };
		if (ok) st.ok++;
		else st.fail++;
		this.stats.set(name, st);
	}

	/** 成否とは別に「世界が変わった(物を得た・動いた)」回数を数える。 */
	recordProgress(name: string): void {
		const st = this.stats.get(name) ?? { ok: 0, fail: 0, progressed: 0 };
		st.progressed++;
		this.stats.set(name, st);
	}

	/**
	 * そのスキルを見限ってよいか。
	 *
	 * 試行が十分あって、ほとんど成功しないもの。材料不足のような一時的な
	 * 失敗と区別できないので、外すのではなくプロンプトで注意を促すに留める。
	 * 完全に外すと、材料が揃った後も二度と選ばれなくなる。
	 */
	reliability(name: string): SkillReliability | null {
		const st = this.stats.get(name);
		if (!st) return null;
		const tried = st.ok + st.fail;
		if (tried === 0) return null;
		return { tried, rate: st.ok / tried, progressed: st.progressed };
	}
}
