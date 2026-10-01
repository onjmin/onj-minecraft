/**
 * 生き物の分類。名前だけで決める。
 *
 * 反射・会話・ハエの感覚の3か所が同じ線引きを使う。別々に持つとずれる。
 */

/** 狩りの対象。食料の鎖の入口。 */
export const PREY_NAMES = new Set(["cow", "pig", "sheep", "chicken", "rabbit"]);

/** 攻撃してくる相手かどうか。名前で判断する。 */
export function isHostileMob(name: string): boolean {
	const hostile = [
		"zombie",
		"skeleton",
		"creeper",
		"spider",
		"enderman",
		"witch",
		"drowned",
		"husk",
		"stray",
		"phantom",
		"slime",
		"magma_cube",
		"pillager",
		"vindicator",
		"ravager",
		"evocation_illager",
		"blaze",
		"piglin",
		"hoglin",
		"wither",
		"guardian",
		"silverfish",
		"endermite",
		"vex",
	];
	return hostile.some((h) => name.includes(h));
}
