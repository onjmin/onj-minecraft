/**
 * 混雑したら席を譲り、空いたら戻る。
 *
 * Realms は10人までしか入れない。ボットが1枠を占め続けると、人が入れなく
 * なる。近くのエンティティを数えても離れた人は見えないので、サーバーが送る
 * プレイヤー一覧で判断する。
 *
 * 「抜けて」と言われたときも同じ扱いにする。言われてから次の思考まで待たせる
 * のは失礼なので、発言を受けた時点で抜ける。
 */
import type { BedrockDriver } from "../core/driver/bedrock";

/** この人数以上になったら席を譲る。自分を含めた数。 */
export const LEAVE_AT_PLAYERS = Number(process.env.LEAVE_AT_PLAYERS ?? 9);
/** 抜けたあと、様子を見に戻るまでの間隔(ms)。 */
export const REJOIN_INTERVAL_MS = Number(process.env.REJOIN_INTERVAL_MS ?? 120_000);

/** 退出を頼まれたと解釈する言い回し。 */
const LEAVE_REQUESTS = [
	"抜けて",
	"出てって",
	"出て行って",
	"でてって",
	"落ちて",
	"退出",
	"leave",
	"get out",
	"disconnect",
];

export function isLeaveRequest(message: string): boolean {
	const text = message.toLowerCase();
	return LEAVE_REQUESTS.some((w) => text.includes(w.toLowerCase()));
}

/**
 * 席を譲るべきか。
 *
 * 自分を除いた人数で見る。9人の枠に対して他に8人いるなら、自分が抜ければ
 * 1枠空く。
 */
export function shouldYieldSeat(driver: BedrockDriver, selfName: string): boolean {
	const others = driver.onlinePlayers().filter((n) => n !== selfName);
	return others.length + 1 >= LEAVE_AT_PLAYERS;
}
