/**
 * SimHashを用いた類似投稿判定モジュール
 */

// メモリリーク防止のため、定期的にキャッシュをクリアするか、TTL付きのライブラリ（node-cache等）への置き換えを推奨
const simhashCache: Map<string, number[]> = new Map();
const allowedSameCount = 3;

// 定期的にキャッシュを掃除する（例: 1時間ごと）
setInterval(() => simhashCache.clear(), 60 * 60 * 1000);

/**
 * 類似投稿を判定する
 * @param text 判定対象の文字列
 * @param userId 投稿者のユーザーID
 * @returns 類似と判定された場合はtrue
 */
export const isSameSimhash = (text: string, userId: string): boolean => {
	// 短すぎるテキストや特定のコマンドは判定から除外
	if (text.length < 4) return false;

	const simhash = calcSimhash(text);
	if (simhash === null) return false;

	const simhashLog = simhashCache.get(userId) || [];

	// some(): 直近数件のうち、1つでも「ハミング距離が8未満（25%未満の差異）」があれば弾く
	const isSame = simhashLog.some((v) => hammingDistance32(v, simhash) < 8);

	if (isSame) {
		return true;
	}

	// 履歴を更新（最新を先頭に追加し、規定数に絞る）
	const newLog = [simhash, ...simhashLog].slice(0, allowedSameCount);
	simhashCache.set(userId, newLog);

	return false;
};

/**
 * テキストから32bitのSimHashを生成
 */
const calcSimhash = (text: string, ngram = 3, hashbits = 32): number | null => {
	// 英語の単語境界を維持するため、連続する空白を1つにまとめる
	// 文字単位のn-gramを作る際、スペースを完全に消すと単語の結合による誤判定が増えるため
	const normalized = text.trim().replace(/\s+/g, " ");
	if (normalized.length < ngram) return null;

	// n-gramを作成（重複を排除して特徴を抽出）
	const gramsSet = new Set<string>();
	for (let i = 0; i < normalized.length - ngram + 1; i++) {
		gramsSet.add(normalized.slice(i, i + ngram));
	}

	const vector = Array(hashbits).fill(0);

	for (const gram of gramsSet) {
		const hash = fnv1a32(gram);

		for (let i = 0; i < hashbits; i++) {
			const bit = (hash >> i) & 1;
			vector[i] += bit === 1 ? 1 : -1;
		}
	}

	let fingerprint = 0;
	for (let i = 0; i < hashbits; i++) {
		if (vector[i] > 0) {
			fingerprint |= 1 << i;
		}
	}

	return fingerprint >>> 0; // 符号なし32bit整数に変換
};

/**
 * 32bit FNV-1a ハッシュ
 */
const fnv1a32 = (str: string): number => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // オーバーフローを考慮した32bit乗算
	}
	return hash >>> 0;
};

/**
 * 高速ハミング距離計算（Popcount SWAR法）
 */
const hammingDistance32 = (hash1: number, hash2: number): number => {
	let n = (hash1 ^ hash2) >>> 0;

	// ビットが立っている数を数える高速アルゴリズム
	n = n - ((n >> 1) & 0x55555555);
	n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
	return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
};
