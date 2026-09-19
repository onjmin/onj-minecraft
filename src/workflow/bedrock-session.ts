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

/**
 * 退出を頼まれたと解釈する言い回し。
 *
 * 「抜けて」系だけでは足りなかった。2026-08-31 のログで、実在のプレイヤーが
 * 「このbotの動作を止めてほしいです」「このボットは嫌がらせのために導入
 * されたのですか？」と繰り返し頼んでいるのに、どれも一語も引っかからず、
 * ボットは居座ったまま「だから何？」と返していた。
 *
 * 判定は緩めでよい。誤って抜けても2分後に戻るだけだが、居座られた側は
 * その間ずっと不快なままになる。取りこぼしの方が高くつく。
 */
const LEAVE_REQUESTS = [
	"抜けて",
	"出てって",
	"出て行って",
	"でてって",
	"落ちて",
	"退出",
	// 「止めて」系。動作そのものを止めてくれという依頼。
	"止めて",
	"止めろ",
	"とめて",
	"停止",
	"やめて",
	"やめろ",
	"止まって",
	// 迷惑だと言われている。理由を問わず引く。
	"うざい",
	"ウザい",
	"うざ",
	"邪魔",
	"じゃま",
	"迷惑",
	"消えて",
	"帰って",
	"来ないで",
	"leave",
	"get out",
	"disconnect",
	"go away",
	"stop",
	"shut up",
];

export function isLeaveRequest(message: string): boolean {
	const text = message.toLowerCase();
	return LEAVE_REQUESTS.some((w) => text.includes(w.toLowerCase()));
}

/** 自分宛てかどうかを判断する手がかり。 */
export interface AddressCue {
	/** 自分の接続名。 */
	selfName: string;
	/** 自分が最後に発言してからの経過(ms)。発言していなければ null。 */
	botSpokeAgoMs: number | null;
	/** 発言者との距離(ブロック)。見えていなければ null。 */
	speakerDistance: number | null;
}

/** ボットを指す言い方。名前を正確に呼ばなくても宛先は分かる。 */
const BOT_WORDS = ["bot", "ボット", "ぼっと", "くさぼ", "kusabot"];
/** 自分の発言への返事とみなす猶予。 */
export const REPLY_WINDOW_MS = 120_000;
/** この距離より近い人の発言は自分に向けたものとみなす。 */
export const NEARBY_SPEAKER_BLOCKS = 12;

/**
 * 退出要請が自分宛てか。
 *
 * 言い回しだけで抜けると、他人同士のやり取りで抜けてしまう。実測 2026-09-19
 * 12:19、他プレイヤー同士の PK で出た「やめてね」を自分宛てと取って席を譲り、
 * 30秒後に戻る、を繰り返した。名前やボットを指す語が入っているか、自分の
 * 発言の直後か、発言者がすぐ近くにいるか、のどれかなら自分宛てとみなす。
 * 「このbotの動作を止めてほしい」のような依頼は語で拾えるので取りこぼさない。
 */
export function isAddressedToBot(message: string, cue: AddressCue): boolean {
	const text = message.toLowerCase();
	if (cue.selfName && text.includes(cue.selfName.toLowerCase())) return true;
	if (BOT_WORDS.some((w) => text.includes(w))) return true;
	if (cue.botSpokeAgoMs !== null && cue.botSpokeAgoMs <= REPLY_WINDOW_MS) return true;
	if (cue.speakerDistance !== null && cue.speakerDistance <= NEARBY_SPEAKER_BLOCKS) return true;
	return false;
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

// 「他の全員が寝たら席を譲って抜ける」という判定はここに以前あったが、
// カウントだけで判断すると、agent が近くのベッドへ向かっている途中や
// 寝ることに成功した直後にも発火してしまい、狙って寝ようとしている
// 最中に横から切断することがあった。今は agent 側
// (MinecraftAgent.sleepIfOthersSleeping)が実際にベッドを探させ、
// 届く範囲に無かったときだけ agent.onNoBedForSleep 経由で抜ける
// 判断をする。詳細は src/core/agent.ts を参照。
