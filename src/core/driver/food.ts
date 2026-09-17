/**
 * 食べてよいものと、その優先順位。
 *
 * 満腹度が減っても戻す手段が無く、体力が自然回復しないまま殴られて死ぬ、
 * という状態が長く続いていた。ここは「何を食べるか」だけを持ち、
 * 実際に食べる操作はエディションごとの Driver が持つ。
 *
 * 並び順がそのまま優先順位。上にあるものから食べる。
 * 満腹度と隠し満腹度(saturation)の合計が高く、かつ手に入りやすいものを上にする。
 */
export const EDIBLE_PRIORITY = [
	// 焼いた肉。狩り→精錬でボットが自力で用意できる本命。
	"cooked_beef",
	"cooked_porkchop",
	"cooked_mutton",
	"cooked_salmon",
	"cooked_chicken",
	"cooked_rabbit",
	"cooked_cod",
	"bread",
	"baked_potato",
	// 果物・野菜。そのまま食べられる。
	"golden_carrot",
	"carrot",
	"apple",
	"melon_slice",
	"sweet_berries",
	// 光るベリーは洞窟に生えていて、掘っている最中に勝手に集まる。
	"glow_berries",
	"beetroot",
	// 生肉。焼く手段が無いときの最後の手段。生鶏肉だけは食中毒があるので外す。
	"beef",
	"porkchop",
	"mutton",
	"rabbit",
	"salmon",
	"cod",
	"potato",
	// 最後の手段。満腹度は1〜2しか戻らないが、毒も食中毒も無い。
	// 水辺でいくらでも手に入るので、他に何も無いときの繋ぎにはなる。
	// これが抜けていたせいで、熱帯魚を13匹持ったまま満腹度2で餓えていた。
	"dried_kelp",
	"tropical_fish",
] as const;

/**
 * 食べてはいけないもの。
 *
 * 腐肉は空腹、フグは毒と吐き気、生鶏肉は食中毒、毒イモは毒。
 * 満腹度をわずかに戻す代わりに体力を削るので、回復目的では逆効果になる。
 * クモの目は食べると毒。金リンゴは貴重なので通常の食事には回さない。
 */
export const NEVER_EAT = new Set([
	"rotten_flesh",
	"pufferfish",
	"chicken",
	"poisonous_potato",
	"spider_eye",
	"golden_apple",
	"enchanted_golden_apple",
	"chorus_fruit",
	"suspicious_stew",
]);

/**
 * 持ち物から食べるべきものを1つ選ぶ。無ければ null。
 *
 * @param names 持っているアイテム名の一覧
 */
export function pickFood(names: readonly string[]): string | null {
	const have = new Set(names);
	for (const food of EDIBLE_PRIORITY) {
		if (have.has(food) && !NEVER_EAT.has(food)) return food;
	}
	return null;
}

/** 満腹度がこれ未満なら食べる。18 を切ると体力が自然回復しなくなる。 */
export const EAT_BELOW_FOOD = 18;

/**
 * 焼けば食べ物になるもの。生 → 焼き上がり。
 *
 * 狩って持ち帰った肉は、焼かなければ満腹度も回復量も半分以下で、
 * 生鶏肉に至っては食中毒で逆に減る。狩り→焼き→食事が繋がって初めて
 * 「食料を確保した」と言える。全ログ通算で食事は23回しか無く、
 * この鎖はこれまで一度も通っていない。
 */
export const COOKABLE_FOOD = new Map<string, string>([
	["beef", "cooked_beef"],
	["porkchop", "cooked_porkchop"],
	["mutton", "cooked_mutton"],
	["chicken", "cooked_chicken"],
	["rabbit", "cooked_rabbit"],
	["salmon", "cooked_salmon"],
	["cod", "cooked_cod"],
	["potato", "baked_potato"],
	["kelp", "dried_kelp"],
]);

/**
 * 持ち物から「焼けば食べられるもの」を1つ選ぶ。無ければ null。
 *
 * 生でも食べられるもの(牛肉など)もここに入る。焼いた方が回復量が倍近いので、
 * かまどが用意できるなら焼いてから食べる。
 */
export function pickCookable(names: readonly string[]): string | null {
	const have = new Set(names);
	for (const raw of COOKABLE_FOOD.keys()) {
		if (have.has(raw)) return raw;
	}
	return null;
}
