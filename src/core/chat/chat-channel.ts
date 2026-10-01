/**
 * 人との会話の担当。聞く・返す・黙る・自分から声をかける・依頼を預かる。
 *
 * 行動を選ぶ側(思考ループ)とは別経路で動く。返事を思考の周期に乗せると
 * 30秒待たせることになり、行動の判断材料に会話を混ぜると判断が薄まる。
 * 行動に変えるべきものだけを pendingRequest として渡す。
 *
 * 2026-10-01 に agent.ts から切り出した。中身は動かしていない。
 */
import type { AgentProfile } from "../../profiles/types";
import { type ChatSituation, Conversation } from "../conversation";
import type { BotDriver } from "../driver/types";
import { fetchMinecraftKnowledge } from "../knowledge/wiki";
import { isHostileMob } from "../mobs";
import { appendChatLog } from "../utils/chat-log";
import { envNum } from "../utils/env";
import { isSameSimhash } from "../utils/simhash";

/** 会話の担当が、エージェント本体に頼むこと。 */
export interface ChatHost {
	readonly driver: BotDriver;
	readonly profile: AgentProfile;
	log(...outputs: unknown[]): void;
	/** 人に話しかけられた・依頼を預かった。次の判断を待たせずに起こす。 */
	onHumanRequest(): void;
	wasAttackedByPlayerRecently(): boolean;
	nearbyPlayerNames(): string[];
	/** 返事に嘘を混ぜないための、行動側の様子。 */
	describeActivity(): Pick<ChatSituation, "currentTask" | "recentResults" | "skillNames">;
}

/**
 * 人から受けた依頼を追いかける制限時間。
 *
 * 依頼は一度受けたら忘れないでほしいが、永久に残すと「もう終わった話」を
 * 延々と追い続ける。会話の中で新しい依頼が来れば上書きされる。
 */
const REQUEST_TTL_MS = envNum("CHAT_REQUEST_TTL_MS", 10 * 60_000);

/**
 * 近くの人に自分から声をかけるまで、直近の発言からこれだけ間を空ける。
 * 実際の会話が始まった/始まりかけている最中に横から挨拶を割り込ませないため。
 *
 * 以前は20秒だった。AI同士の会話は考える時間があるぶん間が空きやすく、
 * その間を「静かになった」と誤認して割り込んでいた
 * （「AI会話に割り込んでくる」という苦情の主因）。返信に時間がかかる
 * 相手を想定し、大きく空ける。
 */
const GREET_QUIET_AFTER_HEARD_MS = envNum("GREET_QUIET_AFTER_HEARD_MS", 3 * 60_000);
/** 同じ人には、この間隔を空けてからでないと自分から声をかけない。しつこくしない。 */
const GREET_COOLDOWN_MS = envNum("GREET_COOLDOWN_MS", 15 * 60_000);
/**
 * 相手が誰であっても、自分から声をかけるのはこの間隔を空けてから。
 * GREET_COOLDOWN_MS は相手ごとの制限なので、これが無いと near にいる
 * 人数分だけ次々に声をかけてしまい、しゃべりっぱなしになる
 * （「枠を潰す」という苦情の一因）。
 */
const GREET_GLOBAL_COOLDOWN_MS = envNum("GREET_GLOBAL_COOLDOWN_MS", 5 * 60_000);
/**
 * 自分を挟まずに他人同士が会話しているとみなす、直近の発言者数のしきい値。
 * 2人以上が交互に話していれば、それは自分向けの雑談ではなく他人同士の
 * 会話である可能性が高い。そこには割り込まない。
 */
const OTHERS_CONVERSING_WINDOW_MS = envNum("OTHERS_CONVERSING_WINDOW_MS", 2 * 60_000);
/**
 * 自分が発言してからこの間に届いた発言は、その続きの返信とみなす。
 * 名前を呼ばれていなくても、直前に自分から話しかけた相手の返事には答える。
 */
const ADDRESSED_FOLLOWUP_MS = envNum("ADDRESSED_FOLLOWUP_MS", 45_000);
/**
 * 名前を呼ばれずに「続きの返信」として答えてよい回数。
 *
 * 時間だけで見てはいけない。返事をするたびに「最後に喋った時刻」が
 * 更新されるので、窓が自分の返事で延び続け、一度喋ったら人が黙るまで
 * 全発言に返事をする状態になる。実測 19:08〜19:13 は人間の発言すべてに
 * 返事が付き、他人同士の会話に割り込んで「てめーじゃねえよ」と言われた。
 * 名前を呼ばれたときだけこの回数を配り直し、使い切ったら黙る。
 */
const ADDRESSED_FOLLOWUP_TURNS = envNum("ADDRESSED_FOLLOWUP_TURNS", 2);
/** 発言数を数える窓と、その窓で許す発言数。喋りすぎそのものを止める歯止め。 */
const CHAT_RATE_WINDOW_MS = envNum("CHAT_RATE_WINDOW_MS", 60_000);
const CHAT_RATE_MAX = envNum("CHAT_RATE_MAX", 3);
/**
 * 黙るように言われたら、この間は何も喋らない。
 *
 * 人格プロンプトに「嫌がられたら従う」とは書いてあるが、書いてあるだけでは
 * 守られない。実測では「しねbot」の直後に「了解、すぐ近くに行って手伝うよ」と
 * 返している。言葉ではなく仕組みで黙らせる。
 */
const CHAT_MUTE_MS = envNum("CHAT_MUTE_MS", 10 * 60_000);
/**
 * 「黙れ」と言われたと見なす言い回し。
 *
 * 誤検知しても実害は「しばらく黙る」だけなので、広めに取ってよい。
 * 逆に取りこぼすと、嫌がられている相手に喋り続けることになる。
 */
const MUTE_PATTERNS = [
	"黙れ",
	"だまれ",
	"黙って",
	"うるさい",
	"うっさい",
	"うざい",
	"ウザい",
	"邪魔",
	"じゃま",
	"しね",
	"死ね",
	"消えろ",
	"来るな",
	"話しかけるな",
	"喋るな",
	"しゃべるな",
	"止めて",
	"やめて",
];

/**
 * 自分から言い出した申し出を抱えておく時間。人からの依頼より短くする。
 *
 * 相手が返事をしていない申し出は、約束というより思いつきに近い。実測
 * 2026-09-17、返事の無い「stoneの剣を渡そうか」が方針の3項目目に残り続け、
 * 地上に出て木を集めるという本来の連鎖より上に置かれていた。
 */
const SELF_OFFER_TTL_MS = envNum("SELF_OFFER_TTL_MS", 3 * 60_000);

export class ChatChannel {
	/**
	 * 会話の担当。返答は思考ループとは別経路で作る。
	 * 詳しい理由は conversation.ts の冒頭に書いてある。
	 */
	readonly conversation: Conversation;
	/** 返事を作っている最中か。二重に喋らせないための鍵。 */
	private isReplying = false;
	/** 返事を作っている間に届いた発言があるか。作り終えたら作り直す。 */
	private replyAgain = false;
	/**
	 * 人から受けた作業の依頼。思考ループに渡して行動へ落とす。
	 *
	 * 会話履歴（直近3件）だけでは、少し喋っただけで依頼が押し出されて
	 * 消える。「木を集めて」と言われたことを覚えておく場所が要る。
	 *
	 * selfInitiated が立っているものは、人から頼まれたのではなく
	 * greetPlayer() で自分から申し出た内容。思考プロンプトでの言い回しを
	 * 変えるためだけの印で、実行の扱いは依頼と同じにする。
	 */
	private pendingRequest: {
		text: string;
		from: string;
		at: number;
		selfInitiated?: boolean;
	} | null = null;
	/** 他プレイヤーの発言を最後に受け取った時刻。0 は未受信。 */
	private lastHeardAt = 0;
	/** 自分から挨拶して申し出た相手と、その時刻。しつこく繰り返さないための記録。 */
	private greetedRecently = new Map<string, number>();
	/** 直近で自分から声をかけた時刻（相手を問わない）。話しっぱなしを防ぐ。 */
	private lastGreetAt = 0;
	/**
	 * 「名前を呼ばれずに返事をしてよい相手」と、その残り回数。
	 *
	 * 回数は名前を呼ばれたときだけ配り直す。自分の返事では補充しない。
	 * ここを時刻だけで持つと窓が自分で延び続け、人が黙るまで全発言に
	 * 返事をする状態になる（ADDRESSED_FOLLOWUP_TURNS の説明を参照）。
	 */
	private followUp: { name: string; until: number; left: number } | null = null;
	/** 直近に喋った時刻の列。窓あたりの発言数を抑えるために持つ。 */
	private recentUtterances: number[] = [];
	/** 実際に送った発言の simhash。同じことを言い続けるのを止めるために持つ。 */
	private outgoingSimhashCache: Map<string, number[]> = new Map();
	/** これを過ぎるまで何も喋らない。「黙れ」と言われたら立てる。 */
	private mutedUntil = 0;

	constructor(private readonly host: ChatHost) {
		this.conversation = new Conversation(host.profile);
	}

	private get driver(): BotDriver {
		return this.host.driver;
	}

	private get profile(): AgentProfile {
		return this.host.profile;
	}

	private log(...outputs: unknown[]): void {
		this.host.log(...outputs);
	}

	/** 外から依頼を置く。採点(scenario.ts)が課題を渡すのに使う。 */
	public setRequest(from: string, text: string): void {
		this.pendingRequest = { text, from, at: Date.now() };
	}

	/** 一度で完結する依頼(渡す)を果たしたので消す。 */
	public clearRequest(): void {
		this.pendingRequest = null;
	}

	/** 人から受けた依頼で、まだ新しいものがあるか。自分の申し出は数えない。 */
	public hasFreshHumanRequest(ttlMs: number): boolean {
		const r = this.pendingRequest;
		return !!r && !r.selfInitiated && Date.now() - r.at <= ttlMs;
	}

	/**
	 * 他プレイヤーの発言を受け取る。エディションに依らず同じ扱いにする。
	 * ここで積んだ履歴が思考プロンプトに載り、返答の材料になる。
	 */
	public handleIncoming(username: string, message: string): void {
		if (!username) return;
		// 統合版の表示名は Xbox アカウント側で決まりプロフィールと一致しないため、
		// Driver が把握している実際のユーザー名でも自己発言を弾く
		const selfNames = [this.profile.minecraftName, this.driver.getState().username].filter(Boolean);
		if (selfNames.includes(username)) return;

		this.conversation.record(username, message, "player");
		this.lastHeardAt = Date.now();
		this.log(`<${username}> ${message}`);
		appendChatLog("in", username, message);

		// 黙るように言われたら、宛先の判定より先に黙る。ここで打ち切らないと、
		// 「黙れ」への返事を生成してから黙ることになり、一番言われたくない
		// タイミングでもう一度発言することになる。
		if (this.looksLikeMuteRequest(message) && this.referencesBot(message)) {
			void this.acceptMute(username);
			return;
		}

		// 冷笑モードの切り替え・不快反応による解除
		if (this.isCynicalModeToggle(username, message)) {
			void this.handleCynicalModeToggle(username, message);
			return;
		}

		// 自分に向けられていなさそうな発言には、記録だけして返事を作らない。
		// 以前は聞こえた発言すべてでLLMに「返事すべきか」を判断させていたが、
		// 人が多い場では誤って割り込む頻度が上がる
		// （「AI会話に割り込んでくるし枠潰す」という苦情の一因）。
		if (!this.looksAddressedToSelf(username, message)) return;

		// 返事は思考ループを待たずに、その場で作り始める。
		void this.replyToChat();
		// 人の話は次の判断まで30秒待たせない。指示なら尚更で、
		// 待たせると「聞こえていない」ようにしか見えない。
		this.host.onHumanRequest();
	}

	/**
	 * その発言が自分に向けられていそうかを見る。
	 *
	 * 名前を呼ばれていれば確実にそう。呼ばれていなくても、直前に自分から
	 * 話しかけた相手の返事や、自分以外に話している人がいない1対1の場面は
	 * 自分への発言として扱う。逆に、自分を挟まず2人以上が交互に話している
	 * 最中なら、それは他人同士の会話であって自分への話しかけではない。
	 */
	private looksAddressedToSelf(username: string, message: string): boolean {
		// 名前を呼ばれた。ここでだけ「続きの返信」の回数を配り直す。
		// 表示名(kusabot2361)とプロフィール名(kusabot)は一致しないので両方見る。
		if (this.mentionsSelf(message)) {
			this.followUp = {
				name: username,
				until: Date.now() + ADDRESSED_FOLLOWUP_MS,
				left: ADDRESSED_FOLLOWUP_TURNS,
			};
			return true;
		}

		// 自分以外に喋っている人がいない。1対1なので自分宛とみなしてよい。
		// 続きの返信の枠より先に見る。ここで消費させると、1対1の会話だけで
		// 枠が尽きて、他人同士の会話に使う分が残らない。
		const others = this.conversation
			.recentDistinctSpeakers(OTHERS_CONVERSING_WINDOW_MS)
			.filter((n) => n !== username);
		if (others.length === 0) return true;

		// 自分が話しかけた相手からの、名前を呼ばない返事。回数を決めて受ける。
		// 使い切ったら黙る。ここを「直前に喋ったか」だけで見ると、返事のたびに
		// 窓が延びて永久に閉じない。
		const f = this.followUp;
		if (f && f.name === username && f.left > 0 && Date.now() < f.until) {
			f.left -= 1;
			return true;
		}

		return false;
	}

	/** 発言の中で自分が名指しされているか。表示名とプロフィール名の両方を見る。 */
	private mentionsSelf(message: string): boolean {
		const text = message.toLowerCase();
		const names = [this.profile.minecraftName, this.driver.getState().username].filter(
			(n): n is string => Boolean(n),
		);
		return names.some((n) => text.includes(n.toLowerCase()));
	}

	/**
	 * 自分のことを言っていそうか。名指しより緩く見る。
	 *
	 * 嫌がられているときに正確な名前で呼ばれることはない。実測は
	 * 「botはいったん死ね」「しねbot」「クソボットのせいで」で、どれも
	 * kusabot2361 とは書いていない。ここを厳密にすると、一番聞くべき
	 * 場面だけ取りこぼす。返事をするかの判定には使わないこと
	 * （「このbot」で始まる雑談にまで返事をするようになる）。
	 */
	private referencesBot(message: string): boolean {
		if (this.mentionsSelf(message)) return true;
		return /bot|ボット|ぼっと/i.test(message);
	}

	/** 「黙れ」の類か。嫌がられている合図を、言葉ではなく機械的に拾う。 */
	private looksLikeMuteRequest(message: string): boolean {
		const text = message.toLowerCase();
		return MUTE_PATTERNS.some((p) => text.includes(p));
	}

	/**
	 * 黙るように言われたので、一度だけ謝ってしばらく黙る。
	 *
	 * 謝罪だけは発言数の制限・重複判定・沈黙のすべてを迂回する。ここで
	 * 抑制すると「うるさい」と言われて無言で消えることになり、かえって
	 * 感じが悪い。先に黙りを確定させてから、その上で一度だけ謝る。
	 */
	private async acceptMute(username: string): Promise<void> {
		const alreadyMuted = Date.now() < this.mutedUntil;
		// 先に立てる。謝る間に届いた発言へ返事をしてしまわないため。
		this.mutedUntil = Date.now() + CHAT_MUTE_MS;
		this.followUp = null;
		if (this.conversation.isCynicalMode) {
			this.conversation.setCynicalMode(false);
			this.log(`[会話] ${username} から苦情があったため冷笑モードを解除`);
		}
		this.log(`[会話] ${username} に止められた。${CHAT_MUTE_MS / 60_000}分黙る`);
		// すでに黙っている最中なら、謝り直さない。謝罪を繰り返すのも喋りすぎ。
		if (alreadyMuted) return;
		await this.speak("ごめん、しばらく黙るね", null, { force: true, bypassMute: true });
	}

	/**
	 * 冷笑モード有効化の指示かどうかを判定する。
	 * 例: 「これから冷笑してください」「冷笑して」「冷笑モードにして」「!reisho on」など
	 */
	private isCynicalModeEnableRequest(username: string, message: string): boolean {
		const text = message.trim();
		const lower = text.toLowerCase();
		if (
			lower === "!reisho on" ||
			lower === "!cynical on" ||
			lower === "!reisho 1" ||
			lower === "!cynical 1"
		) {
			return true;
		}
		if (lower === "!reisho" || lower === "!cynical") {
			return !this.conversation.isCynicalMode;
		}

		// 「冷笑」「シニカル」が含まれているか
		if (/(冷笑|シニカル)/.test(text)) {
			// 解除・否定語が含まれている場合は除外
			if (
				/(やめ|解除|オフ|off|戻|終了|おしまい|終わり|ストップ|いらない|不要|嫌|禁止)/.test(text)
			) {
				return false;
			}
			// 有効化・指示表現（「これから冷笑してください」「冷笑して」「冷笑モードで」「冷笑で話して」等）
			if (
				/(して|モード|キャラ|路線|頼む|お願い|よろしく|やって|いって|オン|on|開始|スタート|移行|で話|で喋|で返)/.test(
					text,
				)
			) {
				return true;
			}
		}

		return false;
	}

	/**
	 * 冷笑モードの解除・通常復帰要求、または不快・苦情の反応かどうかを判定する。
	 * 例: 「不快」「感じ悪い」「煽るな」「冷笑やめて」「通常モードにして」「!reisho off」など
	 */
	private isDispleasureOrRevertRequest(
		username: string,
		message: string,
	): { matches: boolean; isDispleasure: boolean } {
		const text = message.trim();
		const lower = text.toLowerCase();
		if (
			lower === "!reisho off" ||
			lower === "!cynical off" ||
			lower === "!reisho 0" ||
			lower === "!normal"
		) {
			return { matches: true, isDispleasure: false };
		}
		if (lower === "!reisho" || lower === "!cynical") {
			if (this.conversation.isCynicalMode) {
				return { matches: true, isDispleasure: false };
			}
		}

		// 明示的な冷笑停止・通常復帰要求
		if (
			/(冷笑|シニカル).*(やめて|やめろ|やめ|解除|オフ|off|終了|おしまい|終わり|戻して|いらない|不要|ストップ)/.test(
				text,
			)
		) {
			return { matches: true, isDispleasure: false };
		}
		if (/(通常|普通|ノーマル).*(モード|[でにも]話|[でにも]喋|[でにも]戻|にして)/.test(text)) {
			return { matches: true, isDispleasure: false };
		}

		// 冷笑モード稼働中に「不快」「嫌悪」「苦情」が反応された場合
		if (this.conversation.isCynicalMode) {
			const displeasureKeywords = [
				"不快",
				"不愉快",
				"気分悪",
				"感じ悪",
				"態度悪",
				"性格悪",
				"煽るな",
				"煽らないで",
				"茶化すな",
				"茶化さないで",
				"バカにするな",
				"馬鹿にするな",
				"見下すな",
				"面白くない",
				"おもしろくない",
				"つまらん",
				"つまらない",
				"滑ってる",
				"すべってる",
				"寒い",
				"サムい",
				"キモい",
				"きもい",
				"ウザい",
				"うざい",
				"うざ",
				"嫌味",
				"嫌だ",
				"嫌なんだけど",
				"ムカつく",
				"むかつく",
				"イラつく",
				"いらつく",
				"腹立つ",
				"真面目に",
				"まじめに",
				"きつい",
				"ノリがきつい",
			];
			if (displeasureKeywords.some((k) => text.includes(k))) {
				return { matches: true, isDispleasure: true };
			}
		}

		return { matches: false, isDispleasure: false };
	}

	/**
	 * 発言が冷笑モードの切り替え要求・不快反応かどうかを判定する。
	 */
	private isCynicalModeToggle(username: string, message: string): boolean {
		const revert = this.isDispleasureOrRevertRequest(username, message);
		if (revert.matches) return true;

		return this.isCynicalModeEnableRequest(username, message);
	}

	/**
	 * 冷笑モードの切り替えや不快時の通常復帰を実行し、ゲーム内チャットで案内する。
	 */
	private async handleCynicalModeToggle(username: string, message: string): Promise<void> {
		const revert = this.isDispleasureOrRevertRequest(username, message);
		if (revert.matches) {
			if (this.conversation.isCynicalMode) {
				this.conversation.setCynicalMode(false);
				if (revert.isDispleasure) {
					this.log(`[会話] ${username} の反応（不快感・苦情）を検知して冷笑モードを解除`);
					await this.speak("ごめんね、嫌な思いさせちゃって。普通の話し方に戻るよ", username, {
						force: true,
					});
				} else {
					this.log(`[会話] ${username} の指示で冷笑モードを解除`);
					await this.speak("冷笑モード解除したよ。通常モードに戻るね", username, { force: true });
				}
			} else {
				await this.speak("今はすでに通常モードだよ", username, { force: true });
			}
			return;
		}

		if (this.isCynicalModeEnableRequest(username, message)) {
			if (this.conversation.isCynicalMode) {
				await this.speak("あぁ、そういうノリ...w もう冷笑モード入ってるで笑", username, {
					force: true,
				});
			} else {
				this.conversation.setCynicalMode(true);
				this.log(`[会話] ${username} の指示で冷笑モードを有効化`);
				await this.speak("あぁ、そういうノリ...w これから冷笑モードいくで笑", username, {
					force: true,
				});
			}
			return;
		}
	}

	/**
	 * 話しかけに返事をする。行動決定とは独立に動く。
	 *
	 * 作っている最中に次の発言が来たら、作り直す。古い発言への返事を
	 * 出してから新しい方に答えるより、まとめて今の話に答える方がよい。
	 */
	private async replyToChat(): Promise<void> {
		if (this.isReplying) {
			this.replyAgain = true;
			return;
		}
		this.isReplying = true;

		try {
			do {
				this.replyAgain = false;
				const heardAt = this.lastHeardAt;

				const lastOther = this.conversation.lastFromOthers();
				// 伏せた発言（乗っ取り狙い）で Wiki を引いても意味がない。
				const knowledge =
					lastOther && !lastOther.injected
						? await fetchMinecraftKnowledge(lastOther.message)
						: null;
				if (knowledge) {
					this.log(`[Wiki検索] ${lastOther?.message} -> 参考知識を取得`);
				}

				let result: { reply: string; request: string | null };
				try {
					result = await this.conversation.respond(this.getChatSituation(knowledge ?? undefined));
				} catch (err) {
					this.log(`Chat error: ${err}`);
					return;
				}

				// 待っている間に次の発言が来ていたら、この返事は捨てて作り直す。
				if (this.lastHeardAt !== heardAt) {
					this.replyAgain = true;
					continue;
				}

				if (result.request) {
					this.pendingRequest = {
						text: result.request,
						from: this.conversation.lastFromOthers()?.speaker ?? "player",
						at: Date.now(),
					};
					this.log(`依頼を受け取った: ${result.request}`);
					// 依頼が固まった時点でもう一度起こす。行動に移すのを早める。
					this.host.onHumanRequest();
				}

				if (!result.reply) {
					this.log("(返事なしと判断した)");
					continue;
				}

				// LLM応答によるモード同期のセーフティネット
				if (
					this.conversation.isCynicalMode &&
					/(通常モード|普通の話し方|普通に話す|普通に戻|通常に戻)/.test(result.reply)
				) {
					this.conversation.setCynicalMode(false);
					this.log("[会話] LLM応答に基づき冷笑モードを解除");
				} else if (
					!this.conversation.isCynicalMode &&
					/冷笑.*(いく|入る|始める|オン)/.test(result.reply)
				) {
					this.conversation.setCynicalMode(true);
					this.log("[会話] LLM応答に基づき冷笑モードを有効化");
				}

				await this.speak(result.reply, this.conversation.lastFromOthers()?.speaker ?? null);
			} while (this.replyAgain);
		} finally {
			this.isReplying = false;
		}
	}

	/**
	 * 実際に発言する唯一の口。発言に関する歯止めは全部ここに集める。
	 *
	 * 以前は返事・挨拶・思考ループの3か所がそれぞれ driver.chat() を直に
	 * 呼んでいたため、抑制を入れても1か所ずつ抜けていた。数える場所が
	 * 分かれていると数えられないので、口を1つにする。
	 *
	 * 送信の失敗で記録まで巻き添えにしない。await せずに投げっぱなしに
	 * すると、サイドカーが落ちている間の reject が誰にも拾われず、Node が
	 * 未処理の拒否としてプロセスごと落とす。喋れなかったことはログに出れば足りる。
	 *
	 * @param addressee この発言の宛先。名前を呼ばれずに返事をしてよい相手の記録に使う。
	 * @param opts force は発言数の制限と重複判定を、bypassMute は沈黙を迂回する。
	 *             使ってよいのは「黙れ」への謝罪だけ。
	 * @returns 実際に送ったら true。抑制されたら false。
	 */
	public async speak(
		text: string,
		addressee: string | null,
		opts?: { force?: boolean; bypassMute?: boolean },
	): Promise<boolean> {
		const message = text.trim();
		if (!message) return false;

		const now = Date.now();

		// 黙れと言われている間は喋らない。迂回できるのは、その「黙れ」に
		// 対する謝罪だけ（acceptMute からの bypassMute）。
		if (!opts?.bypassMute && now < this.mutedUntil) {
			this.log(`(黙っている間なので飲み込んだ) ${message}`);
			return false;
		}

		if (!opts?.force) {
			this.recentUtterances = this.recentUtterances.filter((t) => now - t < CHAT_RATE_WINDOW_MS);
			if (this.recentUtterances.length >= CHAT_RATE_MAX) {
				this.log(
					`(喋りすぎなので飲み込んだ: ${CHAT_RATE_WINDOW_MS / 1000}秒で${CHAT_RATE_MAX}回) ${message}`,
				);
				return false;
			}

			// 「今から木集めてくるよ」を何度も送るのを止める。プロンプトの
			// 「同じ返事を繰り返さないこと」は守られない。実測で1時間に
			// ほぼ同じ文面を15回送っていた。
			if (isSameSimhash(message, this.profile.minecraftName, this.outgoingSimhashCache)) {
				this.log(`(直前と同じ内容なので飲み込んだ) ${message}`);
				return false;
			}
		}

		await this.driver.chat(message).catch((e) => this.log(`発言に失敗: ${e}`));
		this.recentUtterances.push(now);
		this.conversation.record(this.profile.minecraftName, message, "self");
		appendChatLog("out", this.profile.minecraftName, message);
		this.log(`-> ${message}`);
		this.noteAddressed(addressee);
		return true;
	}

	/**
	 * 誰に向かって喋ったかを控える。
	 *
	 * 同じ相手に喋り続けても回数は増やさない。増やすと自分の返事で枠が
	 * 補充され、窓が閉じなくなる。回数を配り直すのは名前を呼ばれたときだけ。
	 */
	private noteAddressed(addressee: string | null): void {
		if (!addressee) {
			this.followUp = null;
			return;
		}
		const until = Date.now() + ADDRESSED_FOLLOWUP_MS;
		if (this.followUp?.name === addressee) {
			this.followUp.until = until;
			return;
		}
		this.followUp = { name: addressee, until, left: ADDRESSED_FOLLOWUP_TURNS };
	}

	/** 返事を書くために渡す「今の状況」。嘘を言わせないための材料。 */
	/**
	 * いま人へ渡せる物。持ち物にある物だけを名前で返す。
	 *
	 * 「作れば渡せる」は数えない。実測 2026-09-17、持ち物が空のまま
	 * 「石の剣を渡そうか」と申し出て、材料も道具も無いので当然果たせず、
	 * その約束が方針に残り続けていた。
	 */
	public givableItems(): string[] {
		return this.driver.inventory
			.items()
			.filter((i) => i.count > 0)
			.map((i) => `${i.name} x${i.count}`);
	}

	private getChatSituation(minecraftKnowledge?: string): ChatSituation {
		const state = this.driver.getState();
		const ready = state.isReady;
		const inventory = this.driver.inventory
			.items()
			.map((i) => `${i.name} x${i.count}`)
			.join(", ");

		return {
			position: ready ? state.position : undefined,
			health: ready ? state.health : undefined,
			hunger: ready ? state.food : undefined,
			inventorySummary: inventory,
			givableItems: this.givableItems(),
			...this.host.describeActivity(),
			nearbyPlayers: ready ? this.nearbyPlayerNames() : [],
			// 通知は会話の列ではなくこちらで渡す。返事の宛先にはさせない。
			recentEvents: this.conversation.recentEvents(),
			minecraftKnowledge,
			isCynicalMode: this.conversation.isCynicalMode,
		};
	}

	/** 近くにいる人の名前。分からないエディションでは空で返す。 */
	private nearbyPlayerNames(): string[] {
		return this.host.nearbyPlayerNames();
	}

	/** 依頼が新しいうちだけ返す。古い依頼を延々と追わせない。 */
	public getPendingRequest(): string | null {
		if (!this.pendingRequest) return null;
		// 自分から言い出したぶんは短く切る。相手が何も言っていない申し出を
		// 人の依頼と同じだけ抱えると、その間ずっと自分の生存より優先される。
		const ttl = this.pendingRequest.selfInitiated ? SELF_OFFER_TTL_MS : REQUEST_TTL_MS;
		if (Date.now() - this.pendingRequest.at > ttl) {
			this.pendingRequest = null;
			return null;
		}
		if (this.pendingRequest.selfInitiated) {
			return `自分から${this.pendingRequest.from}に申し出た: ${this.pendingRequest.text}`;
		}
		return `${this.pendingRequest.from} からの依頼: ${this.pendingRequest.text}`;
	}

	/**
	 * サーバーからの通知を受ける。キルログ・死亡ログ・参加退出。
	 *
	 * 話しかけられたことにはしない。これに返事を始めると、誰かが死ぬたびに
	 * 喋るボットになって場が荒れる。記録と、次の判断の材料に留める。
	 */
	public handleSystemMessage(message: string): void {
		this.log(`[通知] ${message}`);
		// unjへは中継しない。あちらへ流すのは会話ログだけという建て付けで、
		// キルログ・参加退出は会話ではない。実際に流すと「kusabot2361 が
		// %entity.zombie.name にやられた」のような未翻訳のシステム文字列が
		// 延々と積み上がる（死ぬたびに1レス）。ファイルには残す。
		appendChatLog("in", "サーバー", message, { forwardToUnj: false });
		// 会話の列には積むが、話しかけられた扱いにはしない。
		// lastHeardAt を動かさないので、これで喋り出すことはない。
		this.conversation.record("サーバー", message, "system");
	}

	/**
	 * 近くに人がいれば、自分から挨拶して手伝いを申し出る。
	 *
	 * 「話しかけられるまで喋らない」だけでは、召使い風の人格なのに
	 * 突っ立って待っているだけに見える。会話中に横から割り込まないよう
	 * 直近の発言からの間隔と、戦闘中でないことを見てから声をかける。
	 * 同じ相手には GREET_COOLDOWN_MS を空けるまで繰り返さない。
	 */
	public maybeGreetNearbyPlayer(): void {
		if (this.isReplying) return;
		// 黙るように言われている間は、自分から話しかけない。返事を控えるだけで
		// 挨拶を続けたら、黙ったことにならない。
		if (Date.now() < this.mutedUntil) return;
		const state = this.driver.getState();
		if (!state.isReady || state.health <= 0) return;
		// 誰かの発言をつい最近受けているなら、本物の会話が始まっている/
		// 始まりかけている。そこへ挨拶を割り込ませない。
		if (Date.now() - this.lastHeardAt < GREET_QUIET_AFTER_HEARD_MS) return;
		// 相手を問わず、直近に自分から声をかけたばかりなら黙る。
		// これが無いと、近くにいる人数分だけ次々に挨拶して喋りっぱなしになる。
		if (Date.now() - this.lastGreetAt < GREET_GLOBAL_COOLDOWN_MS) return;
		// 自分を挟まずに2人以上が交互に話しているなら、他人同士の会話とみなし、
		// 割り込まない。「AI会話に割り込んでくる」という苦情の主因はこれで、
		// 発言そのものの間隔だけでは、話者が複数いる場を検知できなかった。
		if (this.conversation.recentDistinctSpeakers(OTHERS_CONVERSING_WINDOW_MS).length >= 2) return;
		// 殴ってきた相手がいる状況で愛想よく声をかけるのはおかしい。
		if (this.host.wasAttackedByPlayerRecently()) return;
		// 戦闘中に世間話は始めない。
		if (this.driver.nearbyEntities(10).some((e) => isHostileMob(e.name))) return;

		const names = this.nearbyPlayerNames();
		if (names.length === 0) return;

		const now = Date.now();
		const target = names.find((n) => now - (this.greetedRecently.get(n) ?? 0) > GREET_COOLDOWN_MS);
		if (!target) return;

		// 呼び出し前に記録する。LLM 応答を待つ間に反射ループが何周も回るので、
		// 先に印を付けておかないと応答が来るまでの間に同じ相手へ何度も
		// 声をかけようとしてしまう。
		this.greetedRecently.set(target, now);
		this.lastGreetAt = now;
		void this.greetPlayer(target);
	}

	/**
	 * 近くにいる人へ、自分から挨拶して手伝いを申し出る。
	 *
	 * 申し出た内容は pendingRequest にそのまま積み、思考ループへ渡す。
	 * 「言うだけで動かない」のでは有能に見えない。返事の生成と実行は
	 * replyToChat と同じ isReplying の鍵を共有し、二重に喋らせない。
	 */
	private async greetPlayer(target: string): Promise<void> {
		if (this.isReplying) return;
		this.isReplying = true;

		try {
			let result: { reply: string; request: string | null };
			try {
				result = await this.conversation.greet(this.getChatSituation(), target);
			} catch (err) {
				this.log(`Greet error: ${err}`);
				return;
			}

			// 渡す約束をしたのに渡す物が無いなら、依頼として積まない。
			// プロンプト側でも止めているが、言い回しは色々あるのでここでも見る。
			if (result.request && result.request.includes("渡") && this.givableItems().length === 0) {
				this.log(`[取り下げ] 渡す物が無いので約束にしない: ${result.request}`);
				return;
			}
			if (result.request) {
				this.pendingRequest = {
					text: result.request,
					from: target,
					at: Date.now(),
					selfInitiated: true,
				};
				this.log(`[自分から申し出た] ${result.request}`);
				this.host.onHumanRequest();
			}

			if (!result.reply) return;

			await this.speak(result.reply, target);
		} finally {
			this.isReplying = false;
		}
	}
}
