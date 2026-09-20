/**
 * 反射が何をしたかを、思考(LLM)へ報告するための控え。
 *
 * 反射層は「LLM の判断を待てない場面」のために存在する。だが、そこで起きた
 * ことが LLM に届かなければ、LLM は自分の知らない理由で行動が中断され、
 * 自分の知らない失敗が繰り返されるのを眺めるだけになる。実測 2026-09-19、
 * 生存ルールが「生肉はあるがかまどが無い」で43回失敗し、その間 LLM の
 * プロンプトにはそのことが一度も書かれなかった。丸石を集める判断は LLM が
 * 出せたはずで、出せなかったのは知らされなかったからである。
 *
 * mindcraft の modes.js は同じものを behavior_log として持ち、思考のたびに
 * 履歴へ流し込んでいる。ここもそれに倣う。次の思考で読まれたら消える。
 */
export class ReflexLog {
	private entries: { text: string; count: number }[] = [];

	constructor(private readonly limit = 12) {}

	/** 1行足す。直前と同じ内容なら回数だけ増やす。 */
	note(text: string): void {
		const last = this.entries[this.entries.length - 1];
		if (last && last.text === text) {
			last.count++;
			return;
		}
		this.entries.push({ text, count: 1 });
		if (this.entries.length > this.limit) this.entries.shift();
	}

	/** 思考へ渡す形にして返し、控えを空にする。 */
	flush(): string[] {
		const out = this.entries.map((e) => (e.count > 1 ? `${e.text} (x${e.count})` : e.text));
		this.entries = [];
		return out;
	}

	/** 控えを消さずに見る。テストと表示用。 */
	peek(): string[] {
		return this.entries.map((e) => (e.count > 1 ? `${e.text} (x${e.count})` : e.text));
	}

	get size(): number {
		return this.entries.length;
	}
}
