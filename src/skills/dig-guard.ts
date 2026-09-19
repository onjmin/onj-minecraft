import type { BlockInfo, BotDriver } from "../core/driver/types";

/**
 * 採集の対象から「下へ掘る」ものを外す。
 *
 * 石・鉱石・土の採集は近くのブロックを近い順に掘る。自分の足元やそれより
 * 下のブロックが候補に入ると、掘るたびに1マス沈み、数回で縦穴の底にいる。
 * 初期リスが Y=-41 まで掘り抜かれたのは、この積み重ねが大きい。
 *
 * 序盤に要る物は全部地表にある(木・動物・村・崖に露出した石炭と鉄)。
 * 下へ掘る価値が出るのは鉄のツルハシと松明と食料が揃ってからで、
 * それまでは自分の高さかそれより上のブロックだけを掘る。
 */
export function notBelowFeet(driver: BotDriver, blocks: BlockInfo[]): BlockInfo[] {
	const pos = driver.getState().position;
	const footY = Math.floor(pos.y);
	const fx = Math.floor(pos.x);
	const fz = Math.floor(pos.z);
	const equipped = canDigDown(driver);
	return blocks.filter((b) => {
		// 真下は装備があっても掘らない。落ちるだけで、採集の効率も上がらない。
		if (
			Math.floor(b.position.x) === fx &&
			Math.floor(b.position.z) === fz &&
			b.position.y < footY
		) {
			return false;
		}
		if (equipped) return true;
		// 足の高さより1段下までは、段差として歩いて届く。それより下は掘り下がり。
		return b.position.y >= footY - 1;
	});
}

/** 下へ掘ってよい装備か。鉄のツルハシと松明。 */
export function canDigDown(driver: BotDriver): boolean {
	const names = driver.inventory.items().map((i) => i.name);
	const pickaxe = names.some(
		(n) => n === "iron_pickaxe" || n === "diamond_pickaxe" || n === "netherite_pickaxe",
	);
	const torch = names.includes("torch");
	return pickaxe && torch;
}
