/**
 * 判断の主体(脳)の差し込み口。
 *
 * 次に何をするかを決めるのは脳で、体(agent)は決まったことを実行し、
 * 反射で命を守り、起きたことを脳へ返す。脳は差し替えられる:
 *   - llm: 言葉で状況を読み、スキルを名前で選ぶ(既定)
 *   - fly: ショウジョウバエの全脳モデル(配線図)に感覚を入れ、出力ニューロンの
 *          発火でスキルを選ぶ(BRAIN=fly)
 *
 * 脳はどれも同じ Decision を返す。体の側は脳が何かを知らずに済む。
 */
import type { BotDriver } from "../driver/types";
import type { ParsedThought } from "../llm-output-parser";
import type { ThinkingState } from "../prompt-builder";
import type { SurvivalSnapshot } from "../survival/snapshot";

/**
 * 脳が下した判断。LLM の出力の形(ParsedThought)を共通の形として使う。
 * action が無ければ、いま走っている行動をそのまま続ける。
 */
export type Decision = ParsedThought;

/** 一覧に載っているスキルと、いま投げても無駄ならその理由。 */
export type OfferedSkill = { name: string; blocked: string | null };

/**
 * 脳が読める材料。脳ごとに要るものが違うので、引いたものだけ作る。
 * LLM の状況説明は作るのに時間がかかり、ハエはそれを読まない。
 */
export interface BrainInput {
	/** 反射と同じ生存の事実。 */
	snapshot(): Promise<SurvivalSnapshot>;
	/** LLM 向けの全部入りの状況。 */
	thinkingState(): Promise<ThinkingState>;
	/** 感覚の生の出所(向き・周りの生き物)。読むだけに使うこと。 */
	readonly driver: BotDriver;
	/** いま選べるスキル。 */
	offeredSkills(): OfferedSkill[];
	/** いま走っている行動の名前。無ければ "idle"。 */
	readonly currentTask: string;
	log(...outputs: unknown[]): void;
}

export interface Brain {
	/** ログと計測に出す名前。 */
	readonly name: string;
	/** 起こされなければ、この間隔で考える。 */
	readonly periodMs: number;
	/** 起こされても、前の判断からこれだけは空ける。 */
	readonly minGapMs: number;
	/** この脳だけが使うスキル。体の一覧に足される。 */
	readonly extraSkills?: readonly unknown[];
	think(input: BrainInput): Promise<Decision>;
}
