/**
 * 環境変数の読み取り。空文字を「未設定」として扱う。
 *
 * `process.env.X ?? default` は undefined のときしか既定値に落ちない。
 * ところが .env に `X=` と書いた行は、node --env-file も docker compose の
 * env_file も空文字として渡してくる。つまり「値を書かずにキーだけ置く」という
 * .env.example の書き方をそのまま使うと、既定値ではなく空文字が採用される。
 *
 * 実害は静かで大きい。CHAT_API_BASE が空文字なら fetch("/chat/completions") が
 * URL のパースに失敗し、CHAT_TIMEOUT_MS が空文字なら Number("") === 0 になって
 * すべての要求が即座に中断される。どちらも「モデルが黙っている」ようにしか
 * 見えないので、原因に辿り着くまでが長い。
 */

/** 空文字と空白だけの値は未設定とみなす。 */
export function envStr(name: string, fallback: string): string {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const trimmed = raw.trim();
	return trimmed === "" ? fallback : trimmed;
}

/** "true"/"1" のときだけ true。それ以外（未設定・空・"false"等）は既定値。 */
export function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "") return fallback;
	return trimmed === "true" || trimmed === "1";
}

/**
 * 数値として読む。空文字はもちろん、数値でない値も既定値に落とす。
 * 「0 になって全部止まる」より「既定値で動き続ける」方が事故が小さい。
 */
export function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const trimmed = raw.trim();
	if (trimmed === "") return fallback;
	const value = Number(trimmed);
	if (!Number.isFinite(value)) {
		console.error(`[env] ${name}="${raw}" は数値として読めません。既定値 ${fallback} を使います`);
		return fallback;
	}
	return value;
}
