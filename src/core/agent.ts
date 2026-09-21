import fs from "node:fs";
import path from "node:path";
import mineflayer, { type ControlState } from "mineflayer";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import type { AgentProfile } from "../profiles/types";
import { BED_WOOL_COUNT, pickBedWool, totalWool } from "../skills/building/bed";
import { collectStoneSkill, stoneScanner } from "../skills/collecting/stone";
import { craftingManager as toolCraftingManager } from "../skills/crafting/tool";
import { craftingManager } from "../skills/crafting/weapon";
import { notBelowFeet } from "../skills/dig-guard";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gainedSince, snapshotInventory, totalGain } from "../skills/inventory-delta";
import { giveItemSkill } from "../skills/social/give";
import type { SkillResponse } from "../skills/types";
import { type ChatSituation, Conversation } from "./conversation";
import { pickCookable, pickFood } from "./driver/food";
import { JavaDriver } from "./driver/java";
import type { BotDriver, Position } from "./driver/types";
import { fetchMinecraftKnowledge } from "./knowledge/wiki";
import { chatLlm, llm } from "./llm-client";
import { parseLlmOutput } from "./llm-output-parser";
import { createPerceptionSnapshot, type DamageInfo } from "./perception";
import { buildThinkingPrompt } from "./prompt-builder";
import { SurvivalArbiter } from "./survival/arbiter";
import {
	type FallDeath,
	type HazardZone,
	hazardAt,
	hazardExit,
	noteFallDeath,
	parseHazardFile,
} from "./survival/hazard";
import { SurvivalMetrics } from "./survival/metrics";
import { ReflexLog } from "./survival/reflex-log";
import {
	BURIED_THICKNESS,
	DAWN_HOSTILE_HOLD_TICK,
	DEATH_STORM_LIMIT,
	DEEP_UNDERGROUND_GAP,
	HUNT_RANGE,
	SHELTER_HEALTH,
	type SurvivalActions,
	shelterBlocker,
} from "./survival/rules";
import { describeSituation } from "./survival/situation";
import type { SurvivalSnapshot } from "./survival/snapshot";
import type { SafeBot } from "./types";
import { appendChatLog } from "./utils/chat-log";
import { emitDiscordWebhook, translateWithRoleplay } from "./utils/discord-webhook";
import { envNum } from "./utils/env";
import { isSameSimhash } from "./utils/simhash";

const tryLoad = (bot: any, name: string, mod: any) => {
	if (!mod) {
		console.error(`[Error] ${name} module not found`);
		return;
	}
	// autoEat は loader オブジェクトを返すことがあるため特別な処理
	let p = mod?.plugin || (typeof mod === "function" ? mod : null);
	// loader オブジェクトが返ってきた場合
	if (!p && mod?.loader && typeof mod.loader === "function") {
		p = mod.loader;
	}
	// default プロパティを確認
	if (!p && mod?.default) {
		p = typeof mod.default === "function" ? mod.default : mod.default?.plugin;
	}
	if (typeof p === "function") {
		bot.loadPlugin(p);
		console.log(`[OK] Loaded ${name}`);
	} else {
		console.error(`[Error] ${name} の読み込みに失敗しました:`, typeof mod, Object.keys(mod || {}));
	}
};

let lastDiscordEmitAt = 0;

/**
 * 同じ行動を中断せずに続けてよい上限。
 *
 * 思考ループが同じスキルを選び直した場合は実行中のものを続けさせるが、
 * それだけだとハングしたスキルに永久に居座られる。以前は30秒ごとの無条件中断が
 * 結果的にその番人を兼ねていたので、代わりの上限をここで持つ。
 */
const MAX_UNINTERRUPTED_MS = envNum("SKILL_MAX_RUN_MS", 300_000);

/**
 * 実行中の行動を、別の行動に乗り換えるために中断してよくなるまでの時間。
 *
 * 思考ループは30秒ごとに判断し直す。それより長くかかる行動は、毎回そこで
 * 切られて最初からやり直しになり、永久に完了しない。本番の Realm で
 * goto.surface が中断なしなら34秒で成功する一方、ループ内では27秒前後で
 * 5回とも切られていた。
 *
 * 代償として、行動の乗り換えが最大でこの時間だけ遅れる。ただし発言は
 * この判定より前で処理されるので、話しかけへの返答は遅れない。
 * 戦闘や体力低下の割り込みも別経路なので影響しない。
 */

/** これを下回ったら戦わずに逃げる。 */
const _FLEE_HEALTH = envNum("FLEE_HEALTH", 10);
/** 死亡地点の落とし物を追いかける制限時間。落下物は5分ほどで消える。 */
const DEATH_LOOT_WINDOW_MS = envNum("DEATH_LOOT_WINDOW_MS", 240_000);
/**
 * 回収に戻って返り討ちに遭ったあと、落とし物を候補から外しておく時間。
 *
 * 秒単位の歯止めであって判断ではない。この間は getDeathPoint() が null を
 * 返し、goto.death_point が一覧に出ない。明けたら取りに行くかどうかは
 * LLM が situation(「さっき殺された場所の近く」)を読んで決める。
 */
const RECOVER_COOLDOWN_MS = envNum("RECOVER_COOLDOWN_MS", 45_000);
/** プレイヤーに殴られてから、人に近づかないでおく時間。 */
const PLAYER_HOSTILITY_MS = envNum("PLAYER_HOSTILITY_MS", 120_000);
/** 一度の反射で振る回数。振り続けて本来の行動を止めない程度に。 */
const _ATTACK_SWINGS = 4;
/** 頭上の蓋に使える物。何でもよいが、貴重な物を使わないよう絞る。 */
/**
 * 蓋や支えに使えるブロック。末尾一致。
 *
 * 石系の加工品(polished_diorite など)や原木も置ける。実測 2026-09-21 07:01、
 * coarse_dirt x2 を選んで支えに使い切り、polished_diorite x5 と原木 x8 を
 * 持ったまま「手に何も持っていません」で蓋を諦めて矢で死んだ。
 */
const PLACEABLE_COVER = [
	"dirt",
	"cobblestone",
	"stone",
	"_planks",
	"_log",
	"_wood",
	"gravel",
	"sand",
	"sandstone",
	"netherrack",
	"diorite",
	"granite",
	"andesite",
	"deepslate",
	"tuff",
	"_bricks",
	"terracotta",
	"mud",
	"moss_block",
];
/**
 * 防具の部位と装備先。並びは driver.inventory.armor() が返す順（頭・胴・脚・足）
 * と一致させること。突き合わせに添字を使っている。
 */
const ARMOR_PIECES: { suffix: string; destination: string }[] = [
	{ suffix: "_helmet", destination: "head" },
	{ suffix: "_chestplate", destination: "torso" },
	{ suffix: "_leggings", destination: "legs" },
	{ suffix: "_boots", destination: "feet" },
];
/** 素材の等級。小さいほど良い。表に無いものは最下位に置く。 */
const ARMOR_MATERIALS = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];

function armorRank(itemName: string): number {
	const i = ARMOR_MATERIALS.findIndex((m) => itemName.startsWith(m));
	return i < 0 ? 99 : i;
}
/**
 * 夜か。mob が湧き、地上を歩けば囲まれる時間帯。
 * 同じ式が反射のあちこちに散らばっていたので一箇所に寄せる。
 */
/** 木を構成するブロックか。蓋・地表・埋まりの判定で「地形」と区別する。 */
function isTreeBlockName(name: string): boolean {
	return /_leaves$|_log$|_wood$|_stem$|^leaves/.test(name);
}

/**
 * 夜明け後も「夜」として扱う猶予(tick)。日が出ても undead はすぐには燃え尽きず、
 * スケルトンは 1 分ほど撃ち続ける。実測 2026-09-21 09:45、時刻 23860 で籠りを
 * 解いて蓋を壊し、時刻 484 に矢で死亡。
 */
const DAWN_SAFE_TICK = envNum("DAWN_SAFE_TICK", 1200);
/**
 * 夜の始まり。13000 だと遅い。地上の明るさは 12500 過ぎから落ち、実測 2026-09-21
 * 10:30、時刻 12733 で明るさ 0、12900 頃にスケルトンの矢で死亡(籠りは 13000 から)。
 * 25 秒ぶんの昼を捨てて先に潜る。
 */
const NIGHT_START_TICK = envNum("NIGHT_START_TICK", 12500);
function isNightTime(timeOfDay: number): boolean {
	const t = ((timeOfDay % 24000) + 24000) % 24000;
	return t >= NIGHT_START_TICK || t < DAWN_SAFE_TICK;
}
/** 一度潜ったら、次に潜り直すまで置く間隔。掘り進み続けないための歯止め。 */
const BURROW_COOLDOWN_MS = envNum("BURROW_COOLDOWN_MS", 60_000);
/**
 * 夜、これ以内に寝床があるなら、潜らずにそこへ戻る。
 *
 * 人が湧きつぶした安全な場所にベッドを置いてくれても、夜の反射は
 * 「その場を掘って潜る」しか持っていなかった。用意された寝床は
 * リスポーン地点としてしか使われず、夜は外を歩いて殺されていた。
 */
const HOME_RETREAT_RADIUS = envNum("HOME_RETREAT_RADIUS", 40);
/** 寝床に着いたとみなす距離。この中にいる間は動かない。 */
const HOME_ARRIVE_RADIUS = envNum("HOME_ARRIVE_RADIUS", 4);
/**
 * 寝床の周りで敵を見る範囲。
 *
 * 統合版でベッドに入れるのは敵が8マス以内にいないとき。同じ範囲で見れば、
 * サーバーが「近くに敵がいる」と言う場面と判断が揃う。
 */
const HOME_THREAT_RADIUS = envNum("HOME_THREAT_RADIUS", 8);
/** 寝床へ向かい直すまでに置く間隔。経路探索を毎周投げないための歯止め。 */
const HOME_RETREAT_COOLDOWN_MS = envNum("HOME_RETREAT_COOLDOWN_MS", 20_000);
/**
 * 寝床へ着けなかったあと、次に試すまで置く間隔。
 *
 * goto は届かないまま成功を返すことがある。実測 02:24:30、10.5 ブロック
 * 手前のベッドへ「行った」あとも距離が変わらなかった(ベッドが屋内や
 * 地下にあって経路が無い)。着けないことに気付かずに待ち続けると、
 * 夜通し外に突っ立つ。しばらくは潜る側に任せる。
 */
const HOME_UNREACHABLE_MS = envNum("HOME_UNREACHABLE_MS", 5 * 60_000);
/**
 * 届かなかったベッドを避けておく時間。
 *
 * 一番近いベッドが、地下や締め切った屋内にあって経路が無いことがある。
 * 実測 (252,56,97) のベッドは真上まで行けるが8ブロック下で、30秒歩いた末に
 * 「目標に届かなかった（残り 0.1 ブロック）」。毎回そこを選び直していては
 * 少し離れた、実際に入れる寝床へ永久に辿り着かない。
 */
const BED_BLACKLIST_MS = envNum("BED_BLACKLIST_MS", 60 * 60_000);
/** 一度に見るベッドの数。近い順に、入れるものが見つかるまで試す。 */
const BED_CANDIDATES = envNum("BED_CANDIDATES", 5);
/**
 * 登録に失敗したあと、次のベッドを試すまでの間隔。
 *
 * 成功したあとの間隔(SPAWN_BED_COOLDOWN_MS=20分)をそのまま使うと、
 * 入れないベッドが5つ並んでいるだけで1時間半かかる。失敗は安い。
 */
const SPAWN_BED_RETRY_MS = envNum("SPAWN_BED_RETRY_MS", 60_000);
/**
 * 潜った/寝床に着いたあと、動かずに待つ時間。
 *
 * これが無いと、潜った1秒後にスキルが動き出して自分の穴から出ていく。
 * 実測 01:40:22 に潜り、01:40:23 に exploring.explore_land が始まっていた。
 */
const SHELTER_HOLD_MS = envNum("SHELTER_HOLD_MS", 5_000);
/**
 * 人から頼まれごとを受けてから、こもるのを控える時間。
 *
 * 夜に安全を優先するのは自分の都合で、頼んだ人はこちらが穴にいる理由を
 * 知らない。頼まれた直後だけは外に出る。依頼の TTL(10分)をそのまま使うと
 * 「木を集めて」の一言で一晩中出歩くことになるので、短く区切る。
 */
const SHELTER_YIELD_MS = envNum("SHELTER_YIELD_MS", 3 * 60_000);
/** 埋まっているかを見る高さ。屋根はこの範囲に収まる前提。 */
const BURIED_SCAN_HEIGHT = 32;
/** これだけ続けて一瞬で終わったら、乗り換えの猶予を外す。 */
const SPIN_LIMIT = envNum("SKILL_SPIN_LIMIT", 3);
/**
 * 地下に埋まっている間、地上へ戻る行動を手放さない時間。
 *
 * 地上へ戻るのは判断ではなく前提条件。木も動物も地上にあるので、
 * 地下にいる限り何も進まない。実測 2026-09-13、27ブロック下から
 * 上がるのに毎回9秒で LLM が別の行動へ乗り換え、11時間そこに居続けた。
 * 登るには柱積みや階段掘りで分単位かかるので、その間は守る。
 */
/**
 * 掴んだまま高さが増えない回数の上限。超えたらロックを外す。
 *
 * ロックは「地上へ戻るのは判断ではなく前提」という理由で、LLM の乗り換えを
 * 握りつぶす。実測 2026-09-16 の8時間で 232 回それをやっていた。LLM は
 * goto.landmark 205回・goto.coords 75回と代替案を出し続けていたのに、
 * すべて保留されている。
 *
 * この取引が成り立つのは、掴んでいるスキルが実際に効いているときだけ。
 * 同日、goto.surface は内部が壊れていて1ブロックも上がらず、粘り強さが
 * そのまま罠になっていた。成否ではなく「高さが増えたか」で見る。地表に
 * 着くまで失敗を返す作りなので、成否で見ると登っている最中に外れる。
 */
/** 行き詰まりの覚え書きを何件・どれだけ持つか。思考プロンプトへ渡す。 */
const STALL_NOTE_LIMIT = 4;
const STALL_NOTE_TTL_MS = envNum("STALL_NOTE_TTL_MS", 3 * 60_000);
/**
 * 自分の列の地表がこれより上なら「地下深く」と見なす。
 *
 * goto.surface の SURFACE_GAP と同じ役目だが、あちらは「登る必要があるか」、
 * こちらは「潜ってよいか・地上へ戻る行動を掴み続けるか」を決める。
 * 1〜2マスのずれは地表の数え方の差で出るので、それを地下と呼ばない幅にする。
 */
/** 自分の列の地表を数えさせる半径。判定に要るのは自分の列だけ。 */
const SURFACE_PROBE_RADIUS = 2;
/** 地表の高さを数え直す間隔。反射は毎周回るので、そのたびには引かない。 */
const SURFACE_PROBE_TTL_MS = 5_000;
/**
 * 計測を1行にまとめてログへ出す間隔。
 *
 * 数字が流れていれば、止まっていることに気づくのに4時間かからない。
 */
const METRICS_REPORT_MS = envNum("METRICS_REPORT_MS", 10 * 60_000);
/** 狩りの対象。食料の鎖の入口。 */
const PREY_NAMES = new Set(["cow", "pig", "sheep", "chicken", "rabbit"]);
/** 地上へ出るスキルの名前。地表にいるときは一覧から外す。 */
const gotoSurfaceSkillName = "goto.surface";
/** 四方を見るときの向き。 */
const BOX_DIRECTIONS = [
	{ x: 1, z: 0 },
	{ x: -1, z: 0 },
	{ x: 0, z: 1 },
	{ x: 0, z: -1 },
];

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
/** 死にすぎを数える窓と、その窓で「死にすぎ」と見なす回数。 */
const DEATH_STORM_WINDOW_MS = envNum("DEATH_STORM_WINDOW_MS", 10 * 60_000);
/**
 * ここまで死んだら、そのワールドから一度抜ける。
 *
 * 潜る・寝床へ戻るで止まらない死に方(水没洞窟の溺死者など)があり、
 * その場合どの反射も効かないまま死亡ログだけが流れ続ける。
 */
const DEATH_STORM_LEAVE_LIMIT = envNum("DEATH_STORM_LEAVE_LIMIT", 5);
/** 誰かがベッドに入ったという知らせを、この間だけ有効とみなす。 */
const SLEEP_REQUEST_TTL_MS = envNum("SLEEP_REQUEST_TTL_MS", 90_000);
/**
 * 寝るために探すベッドの範囲。
 *
 * 人工物(LANDMARK_SEARCH_RADIUS)より狭くしてある。ベッドは「歩いて行って
 * 叩いて戻る」前提なので、片道が長すぎると夜になるか途中で殺される。
 * 遠くの拠点はまず goto.landmark で近づき、着いてからこの範囲に入る。
 */
const BED_SEARCH_RADIUS = envNum("BED_SEARCH_RADIUS", 64);
/**
 * 統合版のベッドのブロック名。
 *
 * 統合版は色を NBT で持つので、ブロック名は "bed" ひとつ。Java版は色ごとに
 * 別の名前になるため、両方を並べる。findBlocksFar は完全一致でしか探せない
 * ので、接尾辞ではなく名前を列挙する必要がある。
 */
const BED_NAMES = [
	"bed",
	"white_bed",
	"orange_bed",
	"magenta_bed",
	"light_blue_bed",
	"yellow_bed",
	"lime_bed",
	"pink_bed",
	"gray_bed",
	"light_gray_bed",
	"cyan_bed",
	"purple_bed",
	"blue_bed",
	"brown_bed",
	"green_bed",
	"red_bed",
	"black_bed",
];
/**
 * リスポーン地点を登録し直すまでの間隔。
 *
 * 統合版はベッドを叩いた時点で、昼でもリスポーン地点が移る(「リスポーン
 * 地点を設定しました」と出る)。寝られなくてもよい。これをやっていなかった
 * ので、死ぬたびにワールドスポーンへ戻されていた。実測で死亡地点は7日間
 * ずっと X:-22〜15 / Z:52〜84 の約40ブロック四方に収まっている。
 */
const SPAWN_BED_COOLDOWN_MS = envNum("SPAWN_BED_COOLDOWN_MS", 20 * 60_000);
/**
 * 人の手が入ったことが分かるブロック。
 *
 * 自然には湧かないもの、あるいは湧いても行く価値がある場所(難破船・村)の
 * ものに絞る。丸石や原木のように洞窟や森で普通に見つかるものは入れない。
 * 入れると「拠点を見つけた」と言って地面へ歩いて行くだけになる。
 */
const MANMADE_BLOCKS = [
	"crafting_table",
	"furnace",
	"blast_furnace",
	"smoker",
	"chest",
	"trapped_chest",
	"barrel",
	"bed",
	"torch",
	"wall_torch",
	"lantern",
	"campfire",
	"bookshelf",
	"anvil",
	"ladder",
	"glass",
	"glass_pane",
	"white_bed",
	"red_bed",
	"blue_bed",
	"oak_planks",
	"spruce_planks",
	"birch_planks",
	"jungle_planks",
	"acacia_planks",
	"dark_oak_planks",
	"oak_door",
	"spruce_door",
	"iron_door",
	"oak_stairs",
	"cobblestone_stairs",
	"stone_bricks",
	"bricks",
];
/**
 * 人工物を探す範囲。サイドカーが取得している範囲いっぱいまで使う。
 *
 * ここが行き先の供給源になる。狭いと「地上に出たが向かう先が無い」に
 * 逆戻りするので、届く限り遠くを見る。遠すぎて着けなくても、
 * goto.landmark は近づいたぶんを成果として返すので損にはならない。
 */
const LANDMARK_SEARCH_RADIUS = envNum("LANDMARK_SEARCH_RADIUS", 128);
/** 人工物を探し直す間隔。全走査に振れうるので、毎tickは回さない。 */
const LANDMARK_SCAN_INTERVAL_MS = envNum("LANDMARK_SCAN_INTERVAL_MS", 30_000);
/** 覚えておく人工物の数。近い順に残す。 */
const LANDMARK_MEMORY_LIMIT = envNum("LANDMARK_MEMORY_LIMIT", 12);
/** 同じ建物を何度も覚えないための、まとめる粗さ(ブロック)。 */
const LANDMARK_GRID = 8;
/**
 * 思考が何回続けて落ちたら、脳無しで動く判断に切り替えるか。
 *
 * LLM が落ちている間、currentTaskName を更新する者が誰もいなくなる。反射
 * ループは最後に選ばれたスキルを回し続けるので、一瞬で終わるスキルを掴んで
 * いると永久に空回りする。実測 2026-09-11 の 02:48〜09:40、goto.surface を
 * 2184回呼んで「もう地上にいる」と答え続けた。
 */
const THINK_FAILURE_TOLERANCE = envNum("THINK_FAILURE_TOLERANCE", 2);
/** 思考が落ちている間、次に考え直すまでの上限。復帰の取りこぼしを避けて短めに。 */
const THINK_RETRY_MAX_MS = envNum("THINK_RETRY_MAX_MS", 2 * 60_000);
/**
 * 起こされたときでも、前の思考からこれだけは空ける。
 *
 * 失敗のたびに考え直す設計なので、下限が無いと LLM の呼び出しが
 * 失敗の頻度そのものになる。ローカルの 24B は1回に5〜8秒かかる。
 */
const THINK_MIN_GAP_MS = envNum("THINK_MIN_GAP_MS", 10_000);
/** LLM が「籠らない」と言ってから、その判断を効かせる長さ。思考3周ぶん。 */
const SHELTER_DECLINE_TTL_MS = envNum("SHELTER_DECLINE_TTL_MS", 90_000);
/**
 * 潜るとき、掘った先がこれ以上空いていたら掘らない。
 *
 * 「1マス潜って蓋をする」つもりの穴が、洞窟の天井に空けた落とし穴に
 * なっていた。掘る先の下に何があるかを見ていなかったため。9/5〜9/11 の
 * 死因606件のうち death.fell が146件(24%)で、mob に次ぐ2位。落ちた先は
 * 暗い洞窟なので、そこでさらに mob に殺され、持ち物ごと失う。
 */
const BURROW_MAX_DROP = envNum("BURROW_MAX_DROP", 2);
/** 掘る前に下を見る深さ。これより深い空洞は「底なし」と同じに扱う。 */
const BURROW_FALL_SCAN = 8;
/**
 * 丸腰のとき、今いる高さからこれ以上深い落とし物は取りに行かない。
 *
 * 落とし物は洞窟の底にあることが多い。そこは暗くて mob が湧くので、素手で
 * 降りれば同じ死に方をして、拾った物ごとまた落とす。回収の往復そのものが
 * 「初期座標のまわりで死に続ける」主な運動になっていた。
 */
/**
 * 死んだ場所を「避ける場所」として覚える設定。
 *
 * これまで死亡は時刻(recentDeaths)しか残しておらず、場所は捨てていた。
 * 覚えているのは goto.death_point の行き先としてだけで、つまり危険な場所へ
 * 引き寄せる仕組みしか無かった。実測 2026-09-16、(4,52,68) で死に、15分
 * かけて登り直し、2.2ブロック離れた (5,52,70) でまた死んでいる。
 *
 * 水辺・溶岩・湧き層・人に狩られる場所を個別に判定すると、地形や状況の
 * 数を数える作業になる。「二度殺された場所へは近づかない」という1つの
 * 規則にすれば、どれも同じ扱いで覆える。
 */
const DEATH_ZONE_RADIUS = envNum("DEATH_ZONE_RADIUS", 12);
/** 避ける時間。mob は移動するので、永久に立ち入り禁止にはしない。 */
const DEATH_ZONE_TTL_MS = envNum("DEATH_ZONE_TTL_MS", 15 * 60_000);
/** ここまで死んだら避ける。1回は不運のこともあるので2回から。 */
const DEATH_ZONE_STRIKES = envNum("DEATH_ZONE_STRIKES", 2);
/** 覚えておく区域の数。 */
const DEATH_ZONE_LIMIT = 8;

/**
 * 自分から言い出した申し出を抱えておく時間。人からの依頼より短くする。
 *
 * 相手が返事をしていない申し出は、約束というより思いつきに近い。実測
 * 2026-09-17、返事の無い「stoneの剣を渡そうか」が方針の3項目目に残り続け、
 * 地上に出て木を集めるという本来の連鎖より上に置かれていた。
 */
const SELF_OFFER_TTL_MS = envNum("SELF_OFFER_TTL_MS", 3 * 60_000);

/** 明るさをログに書く最短間隔。値が細かく揺れても埋め尽くさないため。 */
const LIGHT_LOG_INTERVAL_MS = envNum("LIGHT_LOG_INTERVAL_MS", 15_000);
/** 抱えておく方針の数。プロンプトの "CURRENT STRATEGY (Max 3)" と揃える。 */
const MAX_STRATEGIES = 3;
/**
 * 寝床(リスポーン地点として登録したベッド)の控え。
 *
 * 再起動で忘れると、次の夜また一から探すことになる。人が用意してくれた
 * 安全な場所を、こちらの都合で忘れてよい理由は無い。
 */
const HOME_FILE = "logs/home.json";
/** 訪れた格子の控え。 */
const VISITS_FILE = "logs/visited.json";
/** 訪問を数える格子の一辺。 */
const VISIT_CELL = 32;
/** 初期リス(危険域の種)。未踏の遠さを測る原点。 */
const SPAWN_X = 6;
const SPAWN_Z = 66;
/**
 * 未踏の方向を測る設定。初期リスを中心に 8 方位を見て、その扇形(半径 64 より
 * 外)への訪問が一番少ない方位を「未踏」とし、目標点は「これまでの最大到達距離
 * + FRONTIER_STEP」の先に置く。行けば行くほど輪が広がる。固定座標ではない
 * (「±300 は一例」オーナー 2026-09-21)。
 */
const FRONTIER_DIRECTIONS = 8;
const FRONTIER_STEP = 150;
const FRONTIER_MIN_RADIUS = 200;
const FRONTIER_MAX_RADIUS = 800;
const FRONTIER_NEAR_IGNORE = 64;
/**
 * 掘り荒らされた区域の控え。中身と計算は survival/hazard.ts。
 *
 * 落下死が固まった場所は自動で足す。再起動で忘れると、また同じ穴に
 * 落ちてから覚え直すことになる。
 */
const HAZARD_FILE = "logs/hazard-zones.json";
/**
 * 人工物が「埋まっている」とみなす、その列の地表からの深さ。
 *
 * 初期リスの作業台や板は Y=14〜61 の穴の中にあり、地表(Y=73〜79)から
 * 12〜60 マス下。これを目印にすると穴へ戻る。2〜3 マスなら地下室や
 * 段差なので目印のまま残す。
 */
const LANDMARK_BURIED_DEPTH = envNum("LANDMARK_BURIED_DEPTH", 4);
/** 人工物の埋まり具合を確かめる範囲。surfaceScan の上限(48)まで。 */
const LANDMARK_SURFACE_RADIUS = 48;
/**
 * 四方を塞がれて掘り抜けるまでの間隔。
 *
 * この反射はログで579回発火していて、破壊の最大の出どころだった。
 * 自分が掘った縦穴の中にいると四方が塞がった判定に常に当てはまるので、
 * 歯止めが無いと「横を掘る→また塞がっている→また掘る」で穴が広がり続ける。
 * 本当に閉じ込められているなら、間隔を空けても抜けられる。
 */
const ESCAPE_DIG_MIN_GAP_MS = envNum("ESCAPE_DIG_MIN_GAP_MS", 3_000);

/**
 * 一回成功したら依頼が消化される類のスキル。
 *
 * ほとんどのスキルは何周もかけて進める前提(木を集めて→何度も
 * collecting.wood を選び直す)なので、依頼は簡単には消さない方がよい。
 * ここに載っているものは逆で、1回の成功が「頼まれたことをやり切った」を
 * 意味する。載せずにいると、pendingRequest の TTL(10分)が切れるまで
 * 同じ依頼を思考プロンプトが見せ続け、同じ行為を繰り返してしまう。
 * 集める系は多めに集めても実害が薄いが、渡す系は渡しすぎると
 * 持ち物を無駄に失うだけなので、ここに含める。
 */
const ONE_SHOT_REQUEST_SKILLS = new Set<string>([giveItemSkill.name]);

/** 攻撃してくる相手かどうか。名前で判断する。 */
function isHostileMob(name: string): boolean {
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

function _distanceTo(
	a: { x: number; y: number; z: number },
	b: { x: number; y: number; z: number },
) {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

type ObservationRecord = {
	action: string;
	rationale: string;
	result: "Success" | "Fail";
	message: string;
};

type StrategicState = {
	strategies: string[]; // FIFO 3
	achievements: string[]; // FIFO 3
	chats: string[]; // FIFO 3 (自分自身の過去発言)
};

/**
 * 起動中の全エージェント。unj-relay.ts が「unjの人間発言を誰の口で喋らせるか」を
 * 選ぶために参照する（agent.tsからunj-bridge.tsへは依存させたくないので、
 * ポーリングと発話先の選択はunj-relay.ts側に置き、ここはレジストリだけ持つ）。
 */
export const activeAgents: MinecraftAgent[] = [];

export class MinecraftAgent {
	/**
	 * mineflayer のボット本体。Java版でのみ生成される。
	 * 統合版では Driver を注入するため未定義になるので、
	 * これを直接触る処理は必ず isJava で守ること。
	 */
	public bot!: SafeBot;
	/** mineflayer 由来の機能（経路探索プラグイン・pvp・ブロック読み取り）が使えるか */
	public readonly isJava: boolean;
	/**
	 * エディション差を吸収する操作層。skills/ からは bot ではなく driver を使うこと。
	 * Java版は JavaDriver、統合版は BedrockDriver に差し替える。
	 */
	public driver: BotDriver;
	private profile: AgentProfile;
	private skills: Map<string, any>;
	private currentTaskName: string = "idle";
	private observationHistory: ObservationRecord[] = [];
	private maxHistory = 3;
	private lastDamageCause: DamageInfo = { type: "fall" };
	private hasSetSkin: boolean = false;
	private latestRationale: string = "";
	private isInCombat: boolean = false;
	private currentSkillPromise: Promise<void> | null = null;
	private shouldStopSkill: boolean = false;
	private combatTarget: any = null;

	/**
	 * 会話の担当。返答は思考ループとは別経路で作る。
	 * 詳しい理由は conversation.ts の冒頭に書いてある。
	 */
	private conversation: Conversation;
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
	/** 直近に死んだ時刻の列。死亡ログを撒き散らしていないか見るために持つ。 */
	private recentDeaths: number[] = [];
	/**
	 * 直近の死に方。夜か、地上か。
	 *
	 * 「夜に地上を歩くと死ぬ」は LLM に事実として渡す。全ログで死因の 62% が
	 * モブで、その大半が夜の地上。木の剣を持つと籠り反射は手を引くので、
	 * 夜に歩くかどうかは LLM の判断になる。判断の材料として、自分が何度
	 * それで死んだかを見せる(2026-09-20 17:35、剣を持って夜に探索して死亡)。
	 */
	private deathFacts: { night: boolean; surface: boolean }[] = [];
	/** 誰かがベッドに入ったのを最後に見た時刻。0 は未受信。 */
	private othersSleepingAt = 0;
	/** 最後にベッドを使った時刻。入り直して自分を起こさないために見る。 */
	private lastBedActivatedAt = 0;
	/**
	 * リスポーン地点として登録したベッドの位置。
	 *
	 * 統合版はベッドを叩けば昼でもリスポーン地点が移る。登録しておかないと、
	 * 死ぬたびにワールドスポーンへ戻され、何度死んでも同じ初期座標の周りを
	 * うろつくことになる。実測で死亡地点は7日間ずっと約40ブロック四方に
	 * 収まっていた。
	 */
	private spawnBed: Position | null = null;
	/** 直前に生まれ直した場所。登録が無いときの復帰先はここだと考える。 */
	private lastRespawnPos: Position | null = null;
	/** 最後にリスポーン地点の登録を試みた時刻。往復を繰り返さないために見る。 */
	private lastSpawnBedAt = 0;
	/** 最後に寝床へ向かい直した時刻。経路探索を毎周投げないために見る。 */
	private lastHomeRetreatAt = 0;
	/** 寝床へ着けなかったので、この時刻までは試さない。0 は未設定。 */
	private homeUnreachableUntil = 0;
	/** 寝床の周りを調べたか。書き出すのは接続ごとに一度でよい。 */
	private inspectedHome = false;
	/** 届かなかったベッド。"x,y,z" -> いつまで避けるか。 */
	private unreachableBeds = new Map<string, number>();
	/**
	 * 見かけた人工物の位置。
	 *
	 * 地上に出ても行き先が無いと、その場でランダムに歩き回るだけで拠点へ
	 * 一向に着かない。視界から外れた建物を覚えておき、向かう先として使う。
	 */
	private knownLandmarks: { position: Position; name: string; at: number; buried: boolean }[] = [];
	/** 最後に人工物を探した時刻。全走査に振れうるので間隔を空ける。 */
	private lastLandmarkScanAt = 0;
	/**
	 * 掘り荒らされた区域。行き先の候補から外し、中にいれば歩いて出る。
	 *
	 * 初期リスの周りがこれで、以前ボット自身が Y=-41〜59 まで掘り抜いた。
	 * 実測 2026-09-19、時間の 90% を地表より下で過ごし、落下死は全部
	 * その真下だった。計算は survival/hazard.ts、控えは HAZARD_FILE。
	 */
	private hazardZones: HazardZone[] = [];
	/** 落下死の記録。固まったら区域として足す。 */
	private fallDeaths: FallDeath[] = [];
	/** 思考が続けて落ちた回数。脳無しで動く判断に切り替えるために数える。 */
	private thinkFailures = 0;
	/** 最後に「四方を塞がれて掘り抜けた」時刻。掘り広げ続けないために見る。 */
	private lastEscapeDigAt = 0;
	/**
	 * 誰かが寝ているのに、近くにベッドが無くて自分は寝られなかったときの
	 * 呼び出し先。統合版は全員が寝ないと朝が来ないので、寝られないなら
	 * 席を譲って抜けるしかない。呼び出し側(bedrock.ts)が設定する。
	 */
	public onNoBedForSleep?: () => void;
	/**
	 * 短い間に死に続けているときの知らせ。
	 *
	 * 死亡ログは死んだ本人ではなく、そのワールドにいる全員のチャット欄に
	 * 流れる。実測 2026-09-17 01:08〜01:09、1分間に4回死んだ。同日の別の
	 * 時間帯には1日141行を数えている。直す当てがないまま居座って流し続ける
	 * より、一度抜けて出直す方が迷惑にならない。戻るのは run-bedrock.sh の
	 * 仕事(終了コード3)。
	 */
	public onDeathStorm?: (count: number) => void;
	/** 連続失敗回数。待機時間を伸ばして暴走を防ぐのに使う。 */
	private consecutiveFailures = 0;
	/** 同じスキルが続けて失敗した回数。失敗直後の再実行の間隔に使う。 */
	private sameFailureStreak = 0;
	private lastFailedSkill = "";
	/** 直前に失敗したスキル名。別のスキルに切り替わったらカウンタを戻す。 */
	private lastFailedTask = "";

	private chatSimhashCache: Map<string, number[]> = new Map();
	private rationaleSimhashCache: Map<string, number[]> = new Map();

	private isReconnecting: boolean = false;
	private hasStartedLoops: boolean = false;

	private currentGoal: goals.Goal | null = null;

	private currentAbort?: AbortController;
	private currentSkillArgs: Record<string, any> = {};
	/** 今の実行を開始した時刻。ハングの検出に使う（1回の実行が長すぎないか）。 */
	private currentExecutionStartedAt = 0;
	/** 今のスキルを担当し始めた時刻。乗り換えてよいかの判断に使う。 */
	private currentTaskSince = 0;
	/** 一瞬で終わる行動が続いた回数。空回りの間隔を空けるのに使う。 */
	private instantRepeats = 0;
	/** スキルごとの、成功を返したのに何も変わらなかった連続回数。 */
	private readonly emptyRuns = new Map<string, number>();
	/**
	 * 生存側が担当を握っているか。
	 *
	 * 握っている間、思考ループは「乗り換え」で実行中の行動を殺してはいけない。
	 * 実測 2026-09-18 09:28、狩りが2秒と7秒で「中断された」で終わっていた。
	 * 止めていたのは敵でも地形でもなく、次の行動を選んだ自分の思考だった。
	 * 裁定者は担当に期限を持っているので、待たせても止まりはしない。
	 */
	private survivalHolding = false;
	/**
	 * 死んだ場所と時刻。持ち物はそこに落ちているので、取りに戻る手掛かり。
	 * 落下物は5分ほどで消えるため、古くなったら捨てる。
	 */
	private deathPoint: {
		position: Position;
		at: number;
		retryAfter?: number;
		/** 取りに行った回数。往復を繰り返して損を広げないための歯止め。 */
		attempts?: number;
	} | null = null;
	/** 最後にプレイヤーから殴られた時刻。人に近づいてよいかの判断に使う。 */
	private attackedByPlayerAt = 0;
	/** 二度以上死んだ場所。近づかないために持つ。 */
	private deathZones: { pos: Position; at: number; count: number }[] = [];
	/** 最後に潜った時刻。掘り進み続けるのを止めるために見る。 */
	private lastBurrowAt = 0;
	/** 最後に蓋を置こうとした時刻。置けない場所で毎周試さないため。 */
	private lastCapAt = 0;
	/** この籠りで蓋に失敗した回数。3 回で諦める(夜明けか死亡で戻る)。 */
	private capFailures = 0;
	/**
	 * 自分で置いた蓋の位置。原木を蓋にしたときの置き直しループを防ぐ。
	 *
	 * 「蓋あり」の判定が2つあり、食い違っていた。capHead は `!== "air"` で
	 * 成功とし、呼び出し側は `!isTreeBlockName()` を足していた。2026-09-21
	 * 11:42 に PLACEABLE_COVER へ `_log`/`_wood` を足した結果、原木が蓋に
	 * 選ばれるようになり、置いた直後に呼び出し側が「蓋なし」と読んで置き直す。
	 * 実測 11:52〜11:55、spruce_log を 16 秒おきに 12 回置き続けた(在庫を
	 * 削りながら、蓋は最初の 1 枚で足りていた)。
	 *
	 * 自然の樹冠を「屋根」と誤認しないための除外なので、自分で置いた1マスは
	 * 対象外でよい。位置が変われば当たらなくなる。
	 */
	private cappedLidAt: Position | null = null;
	/** 今夜潜った回数。同じ場所で 2 回まで(縦穴にしない)。場所が変われば数え直す。 */
	private burrowsThisNight = 0;
	private lastBurrowPos: Position | null = null;
	private lastShelterDiagAt = 0;
	/** 自分の列の地表までの高さ。surfaceScan はサイドカーへの往復なので控えておく。 */
	private surfaceProbe: { at: number; depth: number | null } | null = null;
	/** 「地下では潜らない」と最後に言った時刻。毎周は言わない。 */
	private lastDeepShelterLogAt = 0;
	/**
	 * 生存ルールの裁定者。
	 *
	 * 「誰が担当するか」と「いつまで掴んでよいか」はここだけが決める。
	 * 以前は15個の反射がそれぞれ拒否権を持ち、共有フィールドで合図し合って
	 * いた。組み合わせの数が増える一方で、確かめる手段が本番8時間・1標本
	 * しか無く、5日間で死亡率が動かなかった。
	 */
	/**
	 * 反射が何をしたかの控え。次の思考プロンプトに載せて消える。
	 *
	 * 反射は LLM を待てない場面のためにあるが、そこで起きたことを LLM が
	 * 知らなければ、LLM は自分の知らない理由で中断され、知らない失敗が
	 * 繰り返されるのを眺めるだけになる。
	 */
	private readonly reflexLog = new ReflexLog();
	private readonly arbiter = new SurvivalArbiter({
		log: (m) => this.log(m),
		report: (line) => this.reflexLog.note(line),
	});
	/** 成果の計測。死に方だけでなく、積み上がった量を残す。 */
	private readonly metrics = new SurvivalMetrics({
		savePath: path.join(
			"logs",
			`metrics-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}.json`,
		),
		log: (m) => this.log(m),
	});
	/**
	 * 行き詰まりの覚え書き。
	 *
	 * スキルの中で起きた空回りは、外からは1回の失敗にしか見えない。実測
	 * 2026-09-17 00:15:28、collecting.wood の1回の呼び出しの中で「0ブロック
	 * 移動」を6回繰り返して1秒で終わっていたが、LLM に届くのは「1回失敗」
	 * だけだった。思考の周期(約30秒)より内側で起きることは、こうして
	 * 明示的に外へ出さない限り judgement の材料にならない。
	 */
	private stallNotes: { at: number; text: string }[] = [];
	/** 人から話しかけられて、次の判断を急ぎたいときに立てる。 */
	private humanRequestPending = false;
	/**
	 * LLM が「籠らない」と言った期限。この間、反射 shelter は担当を取らない。
	 *
	 * 思考1周(30秒)より長く、数周ぶんは無い長さ。LLM が言い続けている間だけ
	 * 効く。黙れば既定(籠る)に戻る。
	 */
	private shelterDeclinedUntil = 0;
	/**
	 * 夜の籠りに入ったときの体力。null なら籠っていない。
	 *
	 * 一度籠ったら、夜が明けるか被弾するまで LLM の Hide: no を無視する。
	 * 実測 2026-09-20 16:16〜16:36、LLM が 2 分ごとに Hide を反転させ(許す→
	 * 断る→許す→断る…6回)、そのたびに籠りから出て夜の地上を歩き、矢で死んだ。
	 * 籠り反射は「分単位で握る唯一の例外」として認めてあり、これはその延長
	 * (オーナー承認)。被弾で解くのは、籠っているのに削られているなら籠りが
	 * 効いていないから。
	 */
	private shelterLatch: { health: number } | null = null;
	/**
	 * 被弾で保持を解いたあと、次に保持に入ってよくなる時刻。
	 * 解いた同じ周で反射がまた籠って保持し直すと、LLM に判断を返した
	 * ことにならない(実測 2026-09-20 17:10:54、解いた1行後に再保持)。
	 * LLM が Hide: yes と答えたら待たずに戻る。
	 */
	private shelterLatchBlockedUntil = 0;
	/**
	 * LLM が "Hide: yes" と明示した期限。この間の籠りは LLM の判断として数える。
	 *
	 * 計測(skillIdleRatio)と採点の「握りっぱなし」は、コードが LLM から時間を
	 * 奪っている量を見るためのもの。LLM が自分で許した籠りをそこに混ぜると、
	 * 正しい判断が悪い数字として出る(実測 2026-09-19、night-underground で
	 * LLM が夜明けまで籠ると決めた6分が FAIL の理由になった)。
	 */
	private shelterApprovedUntil = 0;
	/** いまの構え。LLM が Stance 欄で変える。既定は auto。 */
	private stance: "auto" | "flee" | "fight" = "auto";
	/** 思考ループの待ちを途中で切り上げるための呼び出し口。 */
	private wakeThinking: (() => void) | null = null;
	/** 待ちに入る前に来た起こし。次の待ちを最短間隔で切り上げる。 */
	private wakePending = false;
	/**
	 * スキルごとの成否の記録。
	 *
	 * 「成功と報告するが何も得ていない」スキルを、実績で落とすために持つ。
	 * 本番では collecting.stone が「10個収集」と返しながら持ち物が空だった。
	 * ああいうものを人が気付くまで選ばせ続けるのは無駄が大きい。
	 */
	private skillStats = new Map<string, { ok: number; fail: number; progressed: number }>();
	/** 高さの推移。5秒ごとの反射で足す。「登っているのか行き来しているのか」を LLM に見せる。 */
	private heightSamples: { at: number; y: number }[] = [];
	/** いまのスキルを担当し始めたときの高さ。登坂の進みを CURRENT ACTION に出す。 */
	private currentTaskStartY: number | null = null;
	/**
	 * 訪れた場所(32 ブロック格子)と回数。どこが未踏かを LLM に見せるため。
	 *
	 * 実測 2026-09-20〜21、位置の 87% が初期リスから 100 ブロック以内、200 を
	 * 超えた記録は無い。羊に出会えないのは範囲が狭いから、というオーナーの
	 * 指摘(300,±300 の四隅に資源がありそう)を受けて入れた。
	 */
	private visitCells = new Map<string, number>();
	private visitsDirty = false;
	private lastVisitSaveAt = 0;

	private bases: {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	}[] = [];

	private strategicState: StrategicState = {
		strategies: [],
		achievements: [],
		chats: [],
	};

	/**
	 * FIFO 更新（重複チェック込み）
	 */
	private updateFIFO(list: string[], value?: string, max = 3) {
		if (!value || value.trim() === "") return false;

		const trimmedValue = value.trim();

		// すでにリストに含まれている場合は追加しない
		if (list.includes(trimmedValue)) return false;

		list.push(trimmedValue);

		// 指定サイズを超えたら古いものを削除
		if (list.length > max) {
			list.shift();
		}

		return true;
	}

	/**
	 * @param injectedDriver 指定するとそのDriverを使い、mineflayer のボットを作らない。
	 *                       統合版(BedrockDriver)を動かすための入り口。
	 */
	constructor(profile: AgentProfile, skillList: any[], injectedDriver?: BotDriver) {
		this.profile = profile;
		activeAgents.push(this);
		this.skills = new Map(skillList.map((t) => [t.name, t]));
		this.conversation = new Conversation(profile);
		if (process.env.REISHO_MODE === "true" || process.env.CYNICAL_MODE === "true") {
			this.conversation.setCynicalMode(true);
			console.log("[Conversation] Cynical (冷笑) mode enabled by environment variable");
		}
		console.log(`[Chat] model=${chatLlm.modelName} endpoint=${chatLlm.endpoint}`);

		if (injectedDriver) {
			this.isJava = false;
			this.driver = injectedDriver;
			// 危険域を先に読む。寝床が危険域の中なら捨てるので、順が逆だと通らない。
			this.loadHazards();
			this.loadHome();
			this.loadVisits();
			// 他プレイヤーとの意思疎通のため、発言の受信だけは共通で購読する
			this.driver.on("chat", (username: string, message: string) =>
				this.handleIncomingChat(username, message),
			);
			// サーバーからの通知。誰が誰にやられたか、誰が入ってきたか。
			// 返答はさせない。全部に反応すると場の空気を悪くする。
			// 判断の材料として履歴に残すだけにする。
			this.driver.on("system", (message: string) => this.handleSystemMessage(message));
			// 殴られた相手から逃げるのはサイドカーの反射が担当する。
			// ここでは記録だけ。人に殴られたことは覚えておく価値がある。
			// 倒された相手はキルログに名前が出る。推測より確実。
			this.driver.on("killed_by_player", (name: string) => {
				this.log(`[通知] ${name} に倒された。しばらく人に近づかない`);
				this.attackedByPlayerAt = Date.now();
			});
			this.driver.on("attacked_by_player", (d: any) => {
				this.handleSystemMessage(`${d?.name ?? "誰か"} に攻撃された`);
				this.attackedByPlayerAt = Date.now();
			});
			// 誰かがベッドに入ったら覚えておく。統合版は全員が寝ないと朝が
			// 来ないので、起きているのがボット1体でも他の人は夜を越せない。
			// 実測で「クソボットのせいでワイだけ寝ても無理か」と言われている。
			this.driver.on("sleeping", (count: number) => {
				if (!count || count <= 0) return;
				this.othersSleepingAt = Date.now();
				this.log(`[通知] 誰かがベッドに入った(${count}人)`);
			});
			// 死んだ場所を控える。持ち物は全部そこに落ちている。
			this.driver.on("death", (d?: { cause?: string }) => {
				this.noteDeath();
				this.noteDeathPlace(this.driver.getState().position);
				// 落ちて死んだ場所は覚える。固まってきたら、そこは穴だらけ。
				const cause = String(d?.cause ?? "");
				if (
					cause.startsWith("death.fell") ||
					cause === "death.attack.fall" ||
					(cause === "" && this.lastDamageCause?.type === "fall")
				) {
					this.noteFallDeathHere();
				}
				// 回収に戻った先で殺されたなら、まだ敵がそこにいる。
				// 諦めはしないが、すぐ戻ると同じことになる。間を置く。
				// 実測で90秒に4回、ほぼ同じ座標で死に続けた。戻るたびに
				// 拾い直した物をまた落とすので、往復するほど損をする。
				if (this.currentTaskName === gotoDeathPointSkill.name && this.deathPoint) {
					this.log("[反射] 回収に戻った先で死んだ。次に何をするかは LLM が決める");
					// 事実として控える。skillPrecondition が「さっき殺された」と注記し、
					// 取りに戻るかどうかは LLM が決める。以前はここで explore に強制
					// 切替していたが、それはコード側の判断だった。
					this.deathPoint.retryAfter = Date.now() + RECOVER_COOLDOWN_MS;
					return;
				}
				const where = { ...this.driver.getState().position };
				// 穴だらけの区域に落とした物は追わない。取りに戻る先が、
				// さっき落ちた穴そのものになる。
				if (this.isInHazard(where)) {
					this.deathPoint = null;
					this.log(
						`死亡地点 (${where.x.toFixed(0)}, ${where.y.toFixed(0)}, ${where.z.toFixed(0)}) は危険域の中。落とし物は諦める`,
					);
					return;
				}
				this.deathPoint = { position: where, at: Date.now() };
				this.log(
					`死亡地点を記録: (${this.deathPoint.position.x.toFixed(0)}, ${this.deathPoint.position.y.toFixed(0)}, ${this.deathPoint.position.z.toFixed(0)})`,
				);
			});
			// 復帰したら、まず落とし物を取りに行かせる。放っておくと消える。
			//
			// ただし getDeathPoint() で見ること。生のフィールドを見ると、直前の
			// death ハンドラが置いた待ち時間(retryAfter)を無視して回収に戻す。
			// death は respawn の直前に来るので、「返り討ちに遭ったから間を置く」
			// と決めて exploring に切り替えた判断が、毎回ここで上書きされていた。
			// 実測で 01:13〜01:17 の4分間に15回、ほぼ同じ場所で死に続けている。
			this.driver.on("respawn", () => {
				// どこに生まれ直したかを控える。復帰地点の登録が無いとき、LLM に
				// 「次に死んだらどこから始まるか」を伝える唯一の材料になる。
				const p = this.driver.getState().position;
				this.lastRespawnPos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
				// 状況が作り直された。落とし物を取りに行くか、諦めるかを含めて
				// 次の行動は LLM が決める。situation に落とし物の位置と、
				// さっき殺された場所かどうかが載る。
				this.requestImmediateThink();
			});
			// mineflayer 固有の初期化（プラグイン・経路探索設定・イベント配線）は行わない。
			// ループの起動は接続完了後に startLoops() を呼び出す側の責務とする。
			return;
		}

		this.isJava = true;
		this.bot = mineflayer.createBot({
			host: process.env.MINECRAFT_HOST,
			port: Number(process.env.MINECRAFT_PORT),
			username: profile.minecraftName,
			auth: "offline",
			// 未指定なら mineflayer の自動判定に任せる。
			// 自動判定はサーバーのプロトコル番号から minecraftVersion を1つ選ぶが、
			// 同一プロトコルに複数バージョンがぶら下がる場合、
			// minecraft-data にデータが無い方を引いて "No data available" で落ちることがある。
			// 例: protocol 775 は 26.1 / 26.1.1 / 26.1.2 が該当し、データがあるのは 26.1 のみ。
			// その場合は MINECRAFT_VERSION でデータのある版を明示する。
			...(process.env.MINECRAFT_VERSION ? { version: process.env.MINECRAFT_VERSION } : {}),
		});

		// エディション差を吸収する操作層。Java版なので JavaDriver を割り当てる。
		this.driver = new JavaDriver(this);
		// 統合版と同じく、壊したものを控える。危険域を先に読む(寝床の判定に使う)。
		this.loadHazards();
		this.loadHome();

		// インスタンス作成時に一度だけプラグインをロード
		this.bot.loadPlugin(pathfinder);

		// constructor 内でロード (CommonJS require)
		tryLoad(this.bot, "autoEat", require("mineflayer-auto-eat"));
		tryLoad(this.bot, "armorManager", require("mineflayer-armor-manager"));
		tryLoad(this.bot, "pvp", require("mineflayer-pvp"));
		tryLoad(this.bot, "collectblock", require("mineflayer-collectblock"));
		tryLoad(this.bot, "tool", require("mineflayer-tool"));

		// 初期設定（一回だけ）
		if ((this.bot as any).autoEat) {
			(this.bot as any).autoEat.options.priority = "foodPoints";
			(this.bot as any).autoEat.options.bannedFood = ["rotten_flesh", "pufferfish"];
		}

		// collectBlock設定
		if ((this.bot as any).collectBlock) {
			(this.bot as any).collectBlock.setInventoryFilter((item: any) => {
				return item.name.includes("axe") || item.name.includes("pickaxe");
			});
		}

		// tool設定 - 最適なツールを自動選択
		if ((this.bot as any).tool) {
			(this.bot as any).tool.setPrimaryHand();
		}

		// PvP設定 - 敵を自動的に攻撃
		if ((this.bot as any).pvp) {
			(this.bot as any).pvp.setOptions({
				attackRange: 4,
				enemyBlacklist: [],
				halfSpeed: false,
			});
		}

		// イベント登録
		this.initEvents();
	}

	/** 表示名。unj-relay.ts が発話先のエージェントを名前で選ぶために使う。 */
	get minecraftName(): string {
		return this.profile.minecraftName;
	}

	/**
	 * unjから中継された発言をそのままゲーム内チャットへ流す。LLMは使わない
	 * （思考ループ・会話履歴を経由しない直送）。appendChatLogはforwardToUnj:falseで
	 * 呼び、unjへ投稿し返してエコーしないようにする。
	 */
	public async relaySpeak(message: string): Promise<void> {
		await this.driver.chat(message);
		appendChatLog("out", this.profile.minecraftName, message, { forwardToUnj: false });
	}

	/**
	 * 反射ループと思考ループを起動する。多重起動はしない。
	 *
	 * Java版は spawn 時に自動で呼ばれる。統合版は接続の完了タイミングを
	 * 呼び出し側が握っているため、接続後に明示的に呼ぶこと。
	 *
	 * DISABLE_AUTONOMY=1 のときは起動しない。スキルを外部から直接呼んで
	 * 検証する用途で、割り込みを防ぐために使う。
	 */
	/**
	 * 他プレイヤーの発言を受け取る。エディションに依らず同じ扱いにする。
	 * ここで積んだ履歴が思考プロンプトに載り、返答の材料になる。
	 */
	private handleIncomingChat(username: string, message: string): void {
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
		this.humanRequestPending = true;
		this.requestImmediateThink();
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
					this.humanRequestPending = true;
					this.requestImmediateThink();
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
	private async speak(
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
	private givableItems(): string[] {
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
			currentTask: this.currentTaskName,
			recentResults: this.observationHistory
				.slice(-3)
				.map((h) => `${h.action}: ${h.result} (${h.message})`),
			skillNames: Array.from(this.skills.keys()),
			nearbyPlayers: ready ? this.nearbyPlayerNames() : [],
			// 通知は会話の列ではなくこちらで渡す。返事の宛先にはさせない。
			recentEvents: this.conversation.recentEvents(),
			minecraftKnowledge,
			isCynicalMode: this.conversation.isCynicalMode,
		};
	}

	/** 近くにいる人の名前。分からないエディションでは空で返す。 */
	private nearbyPlayerNames(): string[] {
		try {
			return createPerceptionSnapshot(this.driver, this.lastDamageCause).environment.nearbyPlayers;
		} catch {
			return [];
		}
	}

	/** 依頼が新しいうちだけ返す。古い依頼を延々と追わせない。 */
	private getPendingRequest(): string | null {
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
	private handleSystemMessage(message: string): void {
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

	/** 思考ループの待ちを切り上げて、すぐ考え直させる。 */
	private requestImmediateThink(): void {
		const wake = this.wakeThinking;
		this.wakeThinking = null;
		if (wake) {
			wake();
			return;
		}
		// 思考の最中(LLM 呼び出し中)に来た起こしは、待ちに入った時点で効かせる。
		// 捨てると、失敗の直後に起きた出来事が次の30秒周期まで届かない。
		this.wakePending = true;
	}

	public startLoops(): void {
		if (this.hasStartedLoops) return;
		if (process.env.DISABLE_AUTONOMY === "1") return;
		this.hasStartedLoops = true;
		this.startReflexLoop();
		this.startThinkingLoop();
	}

	public log(...outputs: unknown[]) {
		const time = new Intl.DateTimeFormat("ja-JP", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
			timeZone: "Asia/Tokyo",
		}).format(new Date());

		console.log(`[${time}] ${this.profile.displayName}:`, outputs.join(" "));
	}

	/**
	 * イベントリスナーの初期化
	 * spawnの中で他のonを登録しないよう、すべて外出しで定義
	 */
	private initEvents() {
		// --- ログイン/スポーン関連 ---
		this.bot.once("spawn", () => {
			this.log("First spawn - Initializing pathfinder");
			this.setupPathfinderConfig();

			this.startLoops();
		});

		this.bot.on("spawn", () => {
			this.log("Spawned/Respawned!");
			this.applySkinOnce();
		});

		// --- 状態監視（重複登録を避けるためここで行う） ---
		this.bot.on("health", () => this.handleHealthChange());
		// 死亡ログは周りの全員のチャット欄に流れる。撒き散らしていないか数える。
		this.bot.on("death", () => this.noteDeath());
		this.bot.on("entityHurt", (entity) => this.handleEntityHurt(entity));
		this.bot.on("move", () => this.handleEnvironmentCheck());

		// --- パスファインダー ---
		this.bot.on("goal_reached", () => this.log("Goal reached!"));
		this.bot.on("path_update", (results) => {
			if (results.status === "noPath") {
				this.log("No path found.");
			}
		});

		this.bot.on("chat", (username, message) => this.handleIncomingChat(username, message));

		this.bot.on("kicked", (reason: unknown, loggedIn: boolean) => {
			// kick 理由は文字列ではなく JSON テキストコンポーネントで届くため、
			// そのまま埋め込むと [object Object] になって原因が追えない。
			const text = typeof reason === "string" ? reason : JSON.stringify(reason);
			this.log(`Kicked from server: ${text}, loggedIn: ${loggedIn}`);
			this.handleDisconnect("kicked");
		});

		this.bot.on("end", (reason: string) => {
			this.log(`Disconnected: ${reason}`);
			this.handleDisconnect(reason);
		});

		this.bot.on("error", (err: Error) => {
			this.log(`Bot error: ${err.message}`);
			if (err.message.includes("ECONNREFUSED") || err.message.includes("socket")) {
				this.handleDisconnect("error");
			}
		});
	}

	private async handleDisconnect(reason: string) {
		if (this.isReconnecting) return;
		this.isReconnecting = true;

		this.log(`Handling disconnect: ${reason}`);

		this.cancelAllTasks();

		await this.reconnect();
	}

	private async reconnect() {
		const RECONNECT_DELAY = 5000;
		const MAX_RETRIES = 10;

		// 古い接続を残したまま同名で繋ぎ直すと、サーバーに二重ログインと判定され
		// multiplayer.disconnect.duplicate_login で蹴られ続ける。先に確実に切る。
		try {
			this.bot.removeAllListeners();
			this.bot.quit();
		} catch {}

		this.log(`Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`);

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));

				this.log(`Reconnect attempt ${attempt}/${MAX_RETRIES}...`);

				this.bot = mineflayer.createBot({
					host: process.env.MINECRAFT_HOST,
					port: Number(process.env.MINECRAFT_PORT),
					username: this.profile.minecraftName,
					auth: "offline",
					// 初回接続と同じ条件で繋ぐ。ここを揃えないと再接続時だけ
					// 自動判定になり "No data available" で失敗しうる。
					...(process.env.MINECRAFT_VERSION ? { version: process.env.MINECRAFT_VERSION } : {}),
				});

				this.bot.loadPlugin(pathfinder);

				tryLoad(this.bot, "autoEat", require("mineflayer-auto-eat"));
				tryLoad(this.bot, "armorManager", require("mineflayer-armor-manager"));
				tryLoad(this.bot, "pvp", require("mineflayer-pvp"));
				tryLoad(this.bot, "collectblock", require("mineflayer-collectblock"));
				tryLoad(this.bot, "tool", require("mineflayer-tool"));

				if ((this.bot as any).autoEat) {
					(this.bot as any).autoEat.options.priority = "foodPoints";
					(this.bot as any).autoEat.options.bannedFood = ["rotten_flesh", "pufferfish"];
				}

				if ((this.bot as any).collectBlock) {
					(this.bot as any).collectBlock.setInventoryFilter((item: any) => {
						return item.name.includes("axe") || item.name.includes("pickaxe");
					});
				}

				if ((this.bot as any).tool) {
					(this.bot as any).tool.setPrimaryHand();
				}

				if ((this.bot as any).pvp) {
					(this.bot as any).pvp.setOptions({
						attackRange: 4,
						enemyBlacklist: [],
						halfSpeed: false,
					});
				}

				this.initEvents();

				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);
					const onSpawn = () => {
						clearTimeout(timeout);
						this.bot.off("spawn", onSpawn);
						this.bot.off("end", onEnd);
						this.bot.off("error", onError);
						resolve();
					};
					const onEnd = () => {
						clearTimeout(timeout);
						this.bot.off("spawn", onSpawn);
						this.bot.off("end", onEnd);
						this.bot.off("error", onError);
						reject(new Error("Connection ended before spawn"));
					};
					const onError = (err: Error) => {
						clearTimeout(timeout);
						this.bot.off("spawn", onSpawn);
						this.bot.off("end", onEnd);
						this.bot.off("error", onError);
						reject(err);
					};
					this.bot.once("spawn", onSpawn);
					this.bot.once("end", onEnd);
					this.bot.once("error", onError);
				});

				this.log("Reconnected successfully!");
				this.isReconnecting = false;
				return;
			} catch (err) {
				this.log(`Reconnect attempt ${attempt} failed: ${err}`);
				if (attempt < MAX_RETRIES) {
					const delay = Math.min(RECONNECT_DELAY * attempt, 60000);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		this.log("Max reconnect attempts reached. Giving up.");
		this.isReconnecting = false;
	}

	/**
	 * パスファインダーの初期設定
	 */
	private setupPathfinderConfig() {
		const movements = new Movements(this.bot as any);

		movements.allowFreeMotion = true;
		movements.allowSprinting = true;
		movements.canDig = true;
		movements.allow1by1towers = true;
		movements.allowParkour = true; // ジャンプが必要な地形に対応
		movements.allowFreeMotion = true;
		movements.maxDropDown = 4; // 4ブロックまでの落下を許容

		// --- 修正ポイント：破壊不可能なリストから「土」や「葉っぱ」を除去する ---
		const diggableNames = ["dirt", "grass_block", "sand", "gravel", "oak_leaves", "birch_leaves"];

		// 破壊不可能なブロックのセットから、掘削したいブロックを削除
		diggableNames.forEach((name) => {
			const block = this.bot.registry.blocksByName[name];
			if (block) {
				movements.blocksCantBreak.delete(block.id);
			}
		});

		// --- 葉っぱを「空気」扱いにして通り抜けを許可する ---
		Object.values(this.bot.registry.blocks).forEach((block) => {
			if (block.name.endsWith("_leaves")) {
				movements.emptyBlocks.add(block.id);
			}
		});

		// 1. 基本となる足場ブロックの定義
		const buildableBlockNames = ["dirt", "cobblestone", "stone", "netherrack"];
		const buildableBlockIds = new Set<number>();

		// 固定名のブロックを追加
		for (const name of buildableBlockNames) {
			const block = this.bot.registry.blocksByName[name];
			if (block) buildableBlockIds.add(block.id);
		}

		// 2. 「すべての木材（planks）」を動的に追加
		// 内部レジストリを走査して、名前に "_planks" が含まれるものをすべて許可
		Object.values(this.bot.registry.blocks).forEach((block) => {
			if (block.name.endsWith("_planks")) {
				buildableBlockIds.add(block.id);
			}
		});

		// 3. movements に反映
		movements.scafoldingBlocks = Array.from(buildableBlockIds);
		movements.digCost = 1;

		this.bot.pathfinder.setMovements(movements);
		this.bot.pathfinder.thinkTimeout = 5000;
		this.bot.pathfinder.tickTimeout = 100;

		if ((this.bot as any).collectBlock) {
			(this.bot as any).collectBlock.movements = movements;
		}
	}

	/**
	 * スキン適用処理（フラグ管理で連打を防止）
	 */
	private applySkinOnce() {
		if (this.profile.skinUrl && !this.hasSetSkin) {
			this.log(`Setting skin: ${this.profile.skinUrl}`);
			// スポーン直後の安定を待ってから一度だけ実行
			setTimeout(() => {
				// /skin は Java サーバー側プラグイン(SkinsRestorer)のコマンド
				if (this.isJava) this.bot.chat(`/skin url "${this.profile.skinUrl}" slim`);
				this.hasSetSkin = true;
			}, 5000);
		}
	}

	private handleHealthChange() {
		if (this.bot.health < 20) {
			// 必要に応じてロジック追加
		}
	}

	private handleEntityHurt(entity: any) {
		if (!this.bot.entity) return;
		if (entity === this.bot.entity) {
			const attacker = this.bot.nearestEntity(
				(e) =>
					(e.type === "mob" || e.type === "hostile") &&
					!!this.bot.entity &&
					e.position.distanceTo(this.bot.entity.position) < 16,
			);
			this.lastDamageCause = attacker
				? { type: "attack", attacker: attacker.name || attacker.type }
				: { type: "attack", attacker: "unknown" };

			if (attacker && (attacker.type === "mob" || attacker.type === "hostile")) {
				this.enterCombat(attacker);
			}
		}
	}

	private enterCombat(target: any) {
		if (this.isInCombat) return;

		this.log(`Combat detected! Target: ${target.name || target.type}`);
		this.isInCombat = true;
		this.combatTarget = target;
		this.shouldStopSkill = true;

		if (this.currentSkillPromise) {
			this.cancelAllTasks();
		}

		this.startPvp(target);
	}

	private exitCombat() {
		if (!this.isInCombat) return;

		this.log(`Combat ended. Returning to skill mode.`);
		this.isInCombat = false;
		this.combatTarget = null;

		(this.bot as any).pvp?.stop();
		this.bot.clearControlStates();
	}

	private startPvp(target: any) {
		const pvpBot = this.bot as any;
		if (pvpBot.pvp) {
			pvpBot.pvp.attack(target);
		}
	}

	public cancelAllTasks() {
		this.log(`Cancelling all tasks...`);

		// 落ちる前に計測を書き出す。
		//
		// ここは切断・席譲り・終了の合流点で、この後たいてい process.exit する。
		// 定期報告(reportIfDue)を待っていると最後の区間が消え、しかも消えるのは
		// 「切断で終わった回」に偏る。死亡時の保存(metrics.noteDeath)と対で、
		// 分子と分母を噛み合わせるためのもの。
		this.metrics.save();

		this.shouldStopSkill = true;

		if (this.currentAbort) {
			this.currentAbort.abort();
		}

		try {
			this.driver.stopMoving();
		} catch {}

		if (!this.isJava) return;

		try {
			this.bot.pathfinder.setGoal(null);
		} catch {}

		try {
			this.bot.pathfinder.stop();
		} catch {}

		try {
			this.bot.stopDigging();
		} catch {}

		try {
			(this.bot as any).collectBlock?.stop();
		} catch {}

		try {
			(this.bot as any).pvp?.stop();
		} catch {}

		// spawn 前に切断されると bot がまだ初期化されておらず
		// clearControlStates が存在しない。他の停止処理と同様に握りつぶす。
		try {
			this.bot.clearControlStates();
		} catch {}
	}

	private handleEnvironmentCheck() {
		const entity = this.bot.entity;
		if (!entity) return;

		// 落下判定
		if (!entity.onGround && entity.velocity.y < -0.6) {
			this.lastDamageCause = { type: "fall" };
		}

		// 環境判定
		const blockAtFeet = this.bot.blockAt(entity.position);
		if (blockAtFeet) {
			if (blockAtFeet.name === "lava") this.lastDamageCause = { type: "lava" };
			else if (blockAtFeet.name === "fire") this.lastDamageCause = { type: "fire" };
		}

		// 窒息判定
		const oxygen = (this.bot as any).oxygenLevel;
		if (oxygen !== undefined && oxygen <= 0) {
			this.lastDamageCause = { type: "drowning" };
		}
	}

	/**
	 * 直近でプレイヤーに殴られたか。
	 *
	 * 殴られた直後に人へ近づくのは自殺行為。実測で10分に17回死に、
	 * うち14回がプレイヤーによるもので、その間 goto.player が19回選ばれて
	 * いた。殺してくる相手に自分から歩いて行っていた。
	 */
	public wasAttackedByPlayerRecently(withinMs = PLAYER_HOSTILITY_MS): boolean {
		return this.attackedByPlayerAt > 0 && Date.now() - this.attackedByPlayerAt < withinMs;
	}

	/**
	 * 人からの依頼を直接置く。採点(scenario.ts)が「丸石を8個集めて」のような
	 * 課題を与えるために使う。本番ではチャット経由で同じ形になる。
	 */
	public injectRequest(from: string, text: string): void {
		this.pendingRequest = { text, from, at: Date.now() };
		this.humanRequestPending = true;
		this.requestImmediateThink();
	}

	/** 死んだ場所。取りに行く価値があるうちだけ返す。 */
	public getDeathPoint(): Position | null {
		if (!this.deathPoint) return null;
		if (Date.now() - this.deathPoint.at > DEATH_LOOT_WINDOW_MS) {
			// 落下物はもう消えている。追いかけるだけ無駄。
			this.deathPoint = null;
			return null;
		}
		// 直前に返り討ちに遭ったかどうかは隠す理由にしない。事実として
		// skillPrecondition が注記し、行くかどうかは LLM が決める。
		return this.deathPoint.position;
	}

	public clearDeathPoint(): void {
		this.deathPoint = null;
	}

	/**
	 * スキルの前提が満たせていないなら、その理由を英語1行で返す。満たせているなら null。
	 *
	 * 以前はここで一覧から「削って」いた。前提が明らかに満たせないものを LLM に
	 * 選ばせて即失敗させるのは思考を1周捨てるのと同じ、という理由だった。だが
	 * 削ると LLM はその選択肢の存在も、なぜ選べないかも知らない。実測 2026-09-19、
	 * 石室の中から「羊が32m以内にいる」と判定して hunting を出し、地上の判定が
	 * 外れて surface を消す、という誤判定が起きても LLM には見えなかった。
	 * いまは全部見せて、前提が欠けているものには注記を付ける。選ぶのは LLM。
	 *
	 * 例外は「対象そのものが無い」もの(落とし物が無い・人工物を見ていない・
	 * 近くに人がいない)。引数にする対象が存在しないので、注記ではなく外す。
	 * これは判断ではなく、選択肢が空集合だという事実。
	 */
	private skillPrecondition(name: string): string | null {
		const items = this.driver.inventory.items();
		const names = items.map((i) => i.name);
		switch (name) {
			case gotoDeathPointSkill.name: {
				const retry = this.deathPoint?.retryAfter ?? 0;
				if (retry && Date.now() < retry) {
					return "you were just killed retrieving it; whoever killed you is probably still there";
				}
				return null;
			}
			case "collecting.hunting": {
				const prey = ["cow", "pig", "sheep", "chicken", "rabbit"];
				if (!this.driver.nearbyEntities(32).some((e) => prey.includes(e.name))) {
					return "no animal within 32 blocks";
				}
				const depth = this.lastKnownDepth();
				if (depth !== null && depth > DEEP_UNDERGROUND_GAP) {
					return "you are underground; the animal is on the surface above you";
				}
				return null;
			}
			case "collecting.stone":
			case "collecting.mining":
				// ツルハシが無いと石も鉱石も落ちない。壊した跡だけが残る。
				return names.some((n) => n.endsWith("_pickaxe")) ? null : "needs a pickaxe (you have none)";
			case gotoSurfaceSkillName:
				return this.lastKnownDepth() === 0 ? "you are already on the surface" : null;
			case "collecting.wood": {
				const depth = this.lastKnownDepth();
				return depth !== null && depth > DEEP_UNDERGROUND_GAP
					? `no trees underground (surface is ${depth} blocks up)`
					: null;
			}
			case "crafting.tool":
			case "crafting.weapon":
			case "crafting.torch": {
				const hasWood = names.some(
					(n) =>
						n === "stick" ||
						n.endsWith("_planks") ||
						n.endsWith("_log") ||
						n.endsWith("_wood") ||
						n.endsWith("_stem"),
				);
				return hasWood ? null : "needs sticks, planks or logs (you have none)";
			}
			case "survival.secure_food": {
				if (pickFood(names) !== null) return null;
				const prey = this.driver.nearbyEntities(HUNT_RANGE).some((e) => PREY_NAMES.has(e.name));
				if (pickCookable(names) !== null) {
					// 焼く道具が無いなら、このスキルは「かまどが無い」で止まる。
					// 生のまま食べるのは survival.eat の仕事で、それは LLM が選ぶ。
					const cobble = items
						.filter((i) => i.name === "cobblestone" || i.name === "blackstone")
						.reduce((n, i) => n + i.count, 0);
					const furnace = names.includes("furnace");
					if (!furnace && cobble < 8 && !prey) {
						return `you carry raw meat but no furnace and only ${cobble}/8 cobblestone, and no animal is near — it will fail again; to eat the raw meat as-is use survival.eat`;
					}
					return null;
				}
				return prey ? null : "nothing edible, nothing to cook, no animal nearby";
			}
			case "crafting.smelting":
				return names.some((n) => n === "furnace" || n === "cobblestone" || n === "blackstone")
					? null
					: "needs a furnace, or 8 cobblestone to build one (you have neither)";
			case "survival.eat": {
				// 食べる物が無いのに 35 回選ばれていた(実測 2026-09-20 22:00〜22:20)。
				// 対象の有無はこちらで分かる。腐った肉は食べ物に数える(LLM が選ぶ)。
				const state = this.driver.getState();
				if (state.food >= 20) return "hunger is already full (20/20)";
				const edible = pickFood(names) ?? (names.includes("rotten_flesh") ? "rotten_flesh" : null);
				return edible
					? null
					: "nothing edible in inventory (no food, no raw meat, no rotten flesh)";
			}
			case "building.bed": {
				const hasBed = names.some((n) => n === "bed" || n.endsWith("_bed"));
				if (!hasBed && pickBedWool(items) === null) {
					return `needs ${BED_WOOL_COUNT} wool of one color (you have ${totalWool(items)}) plus 3 planks or a log`;
				}
				const hasWood = names.some(
					(n) =>
						n.endsWith("_planks") ||
						n.endsWith("_log") ||
						n.endsWith("_wood") ||
						n.endsWith("_stem"),
				);
				if (!hasBed && !hasWood) return "needs 3 planks or a log for the bed frame (you have none)";
				if (this.isInHazard(this.driver.getState().position)) {
					return "you are inside the hazard zone; a bed here respawns you in the crater — walk out first";
				}
				const depth = this.lastKnownDepth();
				if (depth !== null && depth > DEEP_UNDERGROUND_GAP) {
					return `you are underground (surface is ${depth} blocks up); place it on the surface`;
				}
				return null;
			}
			case "goto.player":
			case "social.give":
				return this.wasAttackedByPlayerRecently()
					? "a player attacked you a moment ago; approaching is risky"
					: null;
			default:
				return null;
		}
	}

	/**
	 * 一覧に載せるか。対象そのものが無いスキルだけを外す(上の説明を参照)。
	 */
	/**
	 * 石の採れ具合。collecting.stone を載せるかと、SITUATION に書く理由の両方が
	 * これを見る。判定は collecting.stone 本体と同じ(近くの石 → 足元より下を除く)。
	 */
	private stoneReach(): "reachable" | "below" | "none" {
		const found = stoneScanner.findNearbyStone(this.driver);
		if (found.length === 0) return "none";
		return notBelowFeet(this.driver, found).length > 0 ? "reachable" : "below";
	}

	/**
	 * いま投げても無駄なら、その理由。投げてよいなら null。
	 *
	 * 前提判定は2系統ある。`skillIsWorthOffering` は一覧を絞る側、
	 * `skillPrecondition` は理由の文面を出す側で、枝の持ち物が違う。
	 * 例えば goto.surface の「地表にいる」は後者にしか無く、
	 * collecting.pickup の「落ちている物が無い」は前者にしか無い。
	 * 片方だけ見ると漏れる。断る側は必ずこれを使う。
	 */
	private skillBlockedReason(name: string): string | null {
		return (
			this.skillPrecondition(name) ??
			(this.skillIsWorthOffering(name)
				? null
				: "its target is not present right now (nothing to act on)")
		);
	}

	private skillIsWorthOffering(name: string): boolean {
		switch (name) {
			case gotoDeathPointSkill.name:
				return this.getDeathPoint() !== null;
			case "goto.landmark":
				return this.getKnownLandmarks().length > 0;
			case "goto.player":
				return this.driver.nearbyEntities(64).some((e) => e.kind === "player");
			case "collecting.pickup":
				// 落ちている物が無いときは載せない。対象そのものが無い。
				return this.driver.nearbyEntities(24).some((e) => e.kind === "item");
			case "collecting.hunting":
				// 動物がいないときは載せない。pickup と同じで、対象そのものが無い。
				//
				// 前提判定(skillPrecondition)には「32 ブロック以内に動物がいない」が
				// 最初からあるのに、一覧を絞っているのはこちらの関数なので効いて
				// いなかった。上の「いま成立しないものは見せない」の注記が挙げて
				// いる「動物がいないのに 20 回選ばれた」がそのまま残っている。
				// 実測 2026-09-22 集計(run-150〜176)、狩りの失敗 72 件のうち
				// 63 件(88%)が "No animals found nearby to hunt."。
				//
				// 深さ(地下にいる)の方は載せたままにする。あちらは「地上へ出れば
				// 狩れる」という情報で、消すと行き先の手掛かりごと消える。
				return this.driver.nearbyEntities(HUNT_RANGE).some((e) => PREY_NAMES.has(e.name));
			case "collecting.stealing":
				// チェストが無いときは載せない(実測 2026-09-20 23:56、無いのに3連続で選んだ)。
				return this.driver.world.findBlock(["chest", "barrel", "trapped_chest"], 16) !== null;
			case "crafting.weapon":
				// 作れる装備が無いときは載せない。木の剣を持ち、丸石も鉄も革も無い状態で
				// 「もう最高品質」と 12 回失敗していた(2026-09-21 02:08〜02:34)。盾は
				// 統合版では鉄が要る。
				return craftingManager.determineNextWeapon(this) !== null;
			case "crafting.tool":
				// 武器と同じ。作る物が無いときは載せない。石の道具を一式持った状態で
				// 「もう最高品質」と 26 回失敗していた(2026-09-21 17:20〜17:40、run166)。
				// 判定は本体と同じ determineNextSkill。handler が先に呼ぶ棒・板の確保は
				// 原木→板材→棒の変換なので、ここの判定(板材+原木×4 で数える)を動かさない。
				return toolCraftingManager.determineNextSkill(this.driver) !== null;
			case collectStoneSkill.name:
				// 足元より下の石しか無いときは載せない。このスキルは下へ掘らないので
				// (dig-guard)、載せても "Stone is only below your feet" で即失敗する。
				// 実測 2026-09-21 run166、20分で 6 回中 6 回がこれ。石が要るなら崖か
				// 洞窟まで歩くしかなく、それは exploring の仕事。外した理由は
				// SITUATION に書く(stoneReach)。黙って消すと、石が要ると分かって
				// いる LLM が石の上で立ち往生する。
				return this.stoneReach() === "reachable";
			case "building.bed": {
				// 羊毛 3 枚(同色)かベッドを持っていないときは載せない。注記では止まらず、
				// 羊毛 0 で選ばれた(2026-09-21 01:57)。作り方は SITUATION に書いてある。
				const items = this.driver.inventory.items();
				return (
					items.some((i) => i.name === "bed" || i.name.endsWith("_bed")) ||
					pickBedWool(items) !== null
				);
			}
			case "survival.eat": {
				// 食べる物が無いときは載せない。前提未達の注記では止まらなかった
				// (実測 2026-09-21 00:52〜00:59、昼の判断 13 回中 13 回が eat で全部失敗)。
				// 満腹のときも載せない。「満腹です」で即失敗する手を 37 回選んでいた
				// (全ログ集計 2026-09-21)。前提未達の注記があっても選ぶ。
				if (this.driver.getState().food >= 20) return false;
				const names = this.driver.inventory.items().map((i) => i.name);
				return pickFood(names) !== null || names.includes("rotten_flesh");
			}
			case "social.give":
				return (
					this.driver.nearbyEntities(64).some((e) => e.kind === "player") &&
					this.driver.inventory.items().length > 0
				);
			default:
				return true;
		}
	}

	private recordSkillOutcome(name: string, ok: boolean) {
		const st = this.skillStats.get(name) ?? { ok: 0, fail: 0, progressed: 0 };
		if (ok) st.ok++;
		else st.fail++;
		this.skillStats.set(name, st);
	}

	/**
	 * そのスキルを見限ってよいか。
	 *
	 * 試行が十分あって、ほとんど成功しないもの。材料不足のような一時的な
	 * 失敗と区別できないので、外すのではなくプロンプトで注意を促すに留める。
	 * 完全に外すと、材料が揃った後も二度と選ばれなくなる。
	 */
	private skillReliability(
		name: string,
	): { tried: number; rate: number; progressed: number } | null {
		const st = this.skillStats.get(name);
		if (!st) return null;
		const tried = st.ok + st.fail;
		if (tried === 0) return null;
		return { tried, rate: st.ok / tried, progressed: st.progressed };
	}

	/** 成否とは別に「世界が変わった(物を得た・動いた)」回数を数える。 */
	private recordSkillProgress(name: string) {
		const st = this.skillStats.get(name) ?? { ok: 0, fail: 0, progressed: 0 };
		st.progressed++;
		this.skillStats.set(name, st);
	}

	/**
	 * 行き詰まりを控える。思考プロンプトへ渡して、判断の材料にさせる。
	 *
	 * スキルの中の空回りや、掴んだまま進まない状態は、外からは1回の失敗に
	 * しか見えない。ここへ書いたものだけが LLM に届く。
	 */
	public noteStall(text: string): void {
		const now = Date.now();
		this.stallNotes = this.stallNotes.filter((n) => now - n.at < STALL_NOTE_TTL_MS);
		// 同じ内容を並べても判断は変わらない。最後の1件だけ残す。
		this.stallNotes = this.stallNotes.filter((n) => n.text !== text);
		this.stallNotes.push({ at: now, text });
		if (this.stallNotes.length > STALL_NOTE_LIMIT) this.stallNotes.shift();
	}

	/** 思考プロンプトへ渡す、行き詰まりの覚え書き。 */
	private getStallNotes(): string[] {
		const now = Date.now();
		this.stallNotes = this.stallNotes.filter((n) => now - n.at < STALL_NOTE_TTL_MS);
		return this.stallNotes.map((n) => n.text);
	}

	private pushHistory(record: ObservationRecord) {
		this.observationHistory.push(record);
		if (this.observationHistory.length > this.maxHistory) this.observationHistory.shift();
	}

	private getHistoryContext(): string {
		return this.observationHistory
			.map(
				(h, i) =>
					`Step ${i + 1}: Action[${h.action}] -> ${h.result}: ${h.message} (Why: ${h.rationale})`,
			)
			.join("\n");
	}

	private async startReflexLoop() {
		this.log(`ReflexLoop started.`);
		await new Promise((r) => setTimeout(r, Math.random() * 2000));

		while (this.driver.getState().isReady) {
			if (this.isInCombat) {
				await this.checkCombatStatus();
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}

			if (this.shouldStopSkill) {
				this.shouldStopSkill = false;
				await new Promise((r) => setTimeout(r, 100));
				continue;
			}

			const skill = this.skills.get(this.currentTaskName);
			if (skill) {
				try {
					if (this.currentAbort && !this.currentAbort.signal.aborted) {
						this.currentAbort.abort();
					}

					const controller = new AbortController();
					this.currentAbort = controller;

					await this.ensureOnLand(controller.signal);
					const survivalHolds = await this.reflexSurvival(controller.signal);

					// 生存側が担当を握っている間はスキルを動かさない。
					//
					// 潜った直後にスキルが走ると、自分の穴から出ていく。実測
					// 01:40:22 に潜り、01:40:23 に exploring.explore_land が
					// 始まっていた。これを一晩くり返して10分で11回死んでいる。
					// 握りっぱなしにならないことは裁定者が保証する(保持には
					// 必ず期限があり、切れれば取り上げられる)。
					if (survivalHolds) {
						await new Promise((r) => setTimeout(r, SHELTER_HOLD_MS));
						continue;
					}

					// 前提が消えたものを投げ直さない。
					//
					// このループは LLM を通さずに currentTaskName を再投入する。
					// 選んだ時点では正当でも、1回走った結果それが崩れると、
					// その後は失敗するだけの実行を秒間隔で繰り返す。実測
					// 2026-09-22 00:33:53〜57、腐肉を食べて満腹度が 20 になった
					// 2 秒後に同じ引数で再実行し "Hunger is already full (20/20)"
					// で失敗している。LLM 側のゲート(選択を断る箇所)を直しても、
					// そちらを通らないのでここには効かない。
					//
					// 空振り(empty)の主因もこれ。goto.surface は「地表にいる」を
					// skillPrecondition が持っているのに再投入され、99 回中 75 回が
					// "Already on the surface" で何も変えていない。goto.coords は
					// 152 回中 113 回。
					//
					// 2系統あるので両方見る。skillIsWorthOffering は一覧を絞る側で
					// goto.surface の枝を持たず、skillPrecondition は理由を出す側で
					// collecting.hunting の深さ判定を持つ。片方だけでは漏れる。
					const blockedReason = this.skillBlockedReason(skill.name);
					if (blockedReason) {
						this.log(`[実行] ${skill.name} の前提が消えたので投げ直さない: ${blockedReason}`);
						this.pushHistory({
							action: skill.name,
							rationale: "(repeat dispatch)",
							result: "Fail",
							message: `Stopped repeating it: ${blockedReason}. Pick another skill.`,
						});
						this.currentTaskName = "idle";
						this.requestImmediateThink();
						await new Promise((r) => setTimeout(r, 500));
						continue;
					}

					let result: SkillResponse | undefined;

					const args = this.currentSkillArgs[skill.name] || {};

					// 引数の要るスキルを、引数無しで掴まされていないか。
					//
					// LLM が "Skill: goto.coords" とだけ返すことがある。その
					// まま走らせると「座標が未指定」で即失敗し、次の思考まで
					// 秒3回それを繰り返す。実測 2026-09-13、14:08 台の
					// ログはこれで埋まっていた。選び直す方が早い。
					const requiredArgs = skill.inputSchema
						? Object.values(skill.inputSchema as Record<string, { optional?: true }>).filter(
								(f) => !f.optional,
							).length
						: 0;
					if (requiredArgs > 0 && Object.keys(args).length === 0) {
						this.log(`${skill.name} は引数が要るのに指定が無い。別の行動に切り替える`);
						this.pickSkillWithoutBrain();
						await new Promise((r) => setTimeout(r, 1000));
						continue;
					}

					// 事後条件を測るための、実行前の世界。
					//
					// 「やったか」ではなく「変わったか」で見る。スキルは自分の
					// 中の都合で成功を返すので、それだけでは空振りが見えない。
					// 実測 2026-09-15、crafting.weapon は sticks=0 planks=0
					// logs=2 という同じ状態から792回動いて、何も作っていない。
					const inventoryBefore = snapshotInventory(this.driver);
					const positionBefore = { ...this.driver.getState().position };
					let executionBeganAt = 0;
					// 実行に入れた時点で暴走カウンタは戻す（結果の成否は下で扱う）
					if (this.consecutiveFailures > 0 && this.currentTaskName !== this.lastFailedTask) {
						this.consecutiveFailures = 0;
					}

					try {
						this.log(
							`${skill.name} start${Object.keys(args).length > 0 ? ` with args: ${JSON.stringify(args)}` : ""}`,
						);
						this.currentExecutionStartedAt = Date.now();
						executionBeganAt = this.currentExecutionStartedAt;
						result = await skill.handler({
							agent: this,
							signal: controller.signal,
							args: args,
						});
					} catch (err) {
						this.log(`${skill.name} aborted`);
						if (err instanceof Error && err?.message !== "Aborted") {
							throw err;
						}
					} finally {
						// 終わったものを「長く走っている」と誤判定しないよう戻す。
						//
						// finally でないと駄目。ここを try の外に置くと、スキルが
						// 中断以外の例外を投げて上の catch へ抜けた場合に素通りし、
						// 開始時刻が残り続ける。残ったまま MAX_UNINTERRUPTED_MS を
						// 過ぎると ranTooLong が永久に真になり、乗り換えの猶予
						// (MIN_UNINTERRUPTED_MS) が二度と効かなくなる。
						this.currentExecutionStartedAt = 0;
					}
					this.log(`${skill.name} end`);
					// 3回続けて何も変わらなかったか。投げ直しを止める判断に使う。
					let spunOut = false;
					{
						const gained = gainedSince(this.driver, inventoryBefore);
						const to = this.driver.getState().position;
						const moved = Math.hypot(
							to.x - positionBefore.x,
							to.y - positionBefore.y,
							to.z - positionBefore.z,
						);
						const changed = totalGain(gained) > 0 || moved > 1;
						// 登坂は「地表に着いた」だけが成功だが、1段でも上がったなら進んでいる。
						// 成功率 0% とだけ見せると、実際に高さを稼いでいる唯一の手を LLM が
						// 捨てる(実測 2026-09-20 23:00、Y=18→24 と登っているのに
						// 「15回試して0%、別を試せ」と出て探索に切り替え、洞窟で行き来した)。
						const climbed = to.y - positionBefore.y >= 1;
						if (changed || climbed) this.recordSkillProgress(skill.name);
						const ranMs = executionBeganAt > 0 ? Date.now() - executionBeganAt : 0;
						this.metrics.noteSkill(
							skill.name,
							result?.success === true,
							changed,
							totalGain(gained),
							ranMs,
						);
						// 成功を返したのに世界が変わっていないなら、それは空振り。
						// 停滞判定は失敗でしか発火しないので、明示的に外へ出す。
						if (result?.success === true && !changed) {
							this.emptyRuns.set(skill.name, (this.emptyRuns.get(skill.name) ?? 0) + 1);
							const times = this.emptyRuns.get(skill.name) ?? 0;
							if (times % SPIN_LIMIT === 0) {
								this.noteStall(
									`${skill.name} reports success but nothing changed ${times} times in a row (no items gained, no movement).`,
								);
								spunOut = true;
							}
						} else if (changed) {
							this.emptyRuns.set(skill.name, 0);
						}
					}

					if (!result) {
						this.log("result of handler is undefined");
						continue;
					}

					// 失敗の理由を残す。これが無いと、ログには start と end しか
					// 出ず、何十回失敗していても原因が分からない。実測、
					// crafting.weapon が1197回空振りしていたのに、ログからは
					// 何が起きているのか読めなかった。
					if (!result.success) {
						this.log(`${skill.name} 失敗: ${result.summary}`);
						// 失敗は判断の材料。30秒の周期を待たず、いま考え直させる。
						// 連発しても LLM を叩き続けないよう、思考ループ側に最短間隔がある。
						this.requestImmediateThink();
					}
					this.recordSkillOutcome(skill.name, result.success);
					// 依頼を果たしたら消す。pendingRequest は TTL(10分)か新しい
					// 依頼で上書きされるまで残り続ける仕組みで、これ自体は
					// 「木を集めて」のように何周もかけて進める依頼には都合がいい
					// (1周目で消えると、続きをやる理由が思考プロンプトから消える)。
					// だが social.give のような一回で完結する行為には向かない。
					// 消さずに置くと、同じ「◯◯に渡そうか」という自分の申し出を
					// 消費し続けてしまい、渡すたびにまた同じ申し出が見え、また
					// 渡す、を TTL が切れるまで繰り返す。集める系は多く集めすぎても
					// 損はないが、渡す系は渡しすぎるとただ持ち物を失うだけになる。
					if (result.success && ONE_SHOT_REQUEST_SKILLS.has(skill.name)) {
						this.pendingRequest = null;
					}
					this.pushHistory({
						action: this.currentTaskName,
						rationale: this.latestRationale || "Continuing task",
						result: result.success ? "Success" : "Fail",
						message: result.summary,
					});
					// 空振りが続いたら、投げ直すのをやめて考え直させる。
					//
					// 失敗は上で requestImmediateThink しているのに、空振り
					// (成功を返したが世界が変わらない)は noteStall で知らせるだけで、
					// ループは同じものを秒間隔で投げ直し続けていた。LLM が選んだのは
					// 1回で、繰り返しはループの都合なので、ここで止めてよい。
					//
					// 前提判定によるガードでは届かない。実測 2026-09-22、
					// goto.surface は skillPrecondition が lastKnownDepth() を見るが、
					// プローブが無い/古いと null を返して `=== 0` が偽になり素通りする。
					// スキル本体は自前で判定して "Already on the surface" と言うので、
					// 両者が食い違う。run-181/182 では空振り 17/17(100%)に対して
					// ガードの発火が 0 回だった。結果を見て止める方が取りこぼさない。
					//
					// 行き先を選ぶのは LLM のまま。ここは「新しい入力なしに同じ
					// 何もしない実行を繰り返さない」だけで、選択を拒否はしない。
					// スキルの戻り文(「同じ座標をまた指しても何も起きない」)が
					// 履歴に載っているので、判断の材料はそろっている。
					if (spunOut) {
						this.log(`[実行] ${skill.name} が ${SPIN_LIMIT} 回続けて空振り。投げ直さず考え直す`);
						this.currentTaskName = "idle";
						this.requestImmediateThink();
					}
					// 同じスキルが失敗し続けるなら、間隔を倍々に広げる(2s→4s→…→20s)。
					// 次の思考が来るまで3秒おきに同じ失敗を繰り返していた(実測
					// 2026-09-19 夜、secure_food が49回連続)。判断ではなく、同じ入力で
					// 同じ結果になるものを叩く回数を減らすだけ。思考が別を選べば戻る。
					if (!result.success) {
						this.sameFailureStreak =
							this.lastFailedSkill === skill.name ? this.sameFailureStreak + 1 : 1;
						this.lastFailedSkill = skill.name;
						const wait = Math.min(20_000, 2_000 * 2 ** Math.min(this.sameFailureStreak - 1, 4));
						await new Promise((r) => setTimeout(r, wait));
					} else {
						this.sameFailureStreak = 0;
						this.lastFailedSkill = "";
					}

					// 一瞬で終わる行動を全速力で回し続けない。
					// goto.surface のように「既に条件を満たしている」と即座に返すものは、
					// 次の思考まで秒1回近い頻度で呼ばれ、ログを埋めるだけになる。
					// 実際に5分で98回叩いていた。
					const elapsed = executionBeganAt > 0 ? Date.now() - executionBeganAt : Infinity;
					this.instantRepeats = elapsed < 1000 ? this.instantRepeats + 1 : 0;
					// 一瞬で終わる呼び出しが続くのは、外から見えない空回り。
					// 回数がまとまったところで1件だけ残す。
					if (this.instantRepeats === SPIN_LIMIT) {
						this.noteStall(
							`${skill.name} returned instantly ${SPIN_LIMIT} times in a row: its preconditions hold but it makes no progress.`,
						);
					}
				} catch (e) {
					const errorMsg = e instanceof Error ? e.message : String(e);
					// 中断は異常ではない。思考ループが別の行動へ乗り換えたときや、
					// 反射が割り込んだときに必ず出る。これを失敗として数えると
					// 暴走カウンタが上がり、意味の無い待機が積み上がる。
					if (errorMsg.includes("中断された") || errorMsg === "Aborted") {
						continue;
					}
					this.log(`Reflex Error: ${errorMsg}`);
					this.lastFailedTask = this.currentTaskName;
					// 同じ失敗を即座に繰り返すとログを埋め尽くして CPU も食う。
					// 未実装の機能を踏んだ場合など、回復の見込みがない失敗ほど待つ。
					this.consecutiveFailures++;
					const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.consecutiveFailures, 5));
					if (errorMsg.includes("まだ実装されていません")) {
						this.log(`未実装の機能のため ${backoff / 1000}秒待機します`);
					}
					await new Promise((r) => setTimeout(r, backoff));
				}
			} else {
				// 指定されたスキルが手元に無い場合の待機先。
				// 探索スキルがあればそれを、無ければ渡された中の最初のものを使う。
				// エディションによって使えるスキルが違うためハードコードしない。
				const fallback = this.skills.has(exploreLandSkill.name)
					? exploreLandSkill.name
					: (this.skills.keys().next().value ?? "idle");
				if (this.currentTaskName === fallback) {
					// 代替先すら無い（または既にそれを指している）なら空回りするので待つ
					await new Promise((r) => setTimeout(r, 2000));
				}
				this.currentTaskName = fallback;
				this.currentTaskStartY = Math.floor(this.driver.getState().position.y);
			}

			// 空回りしているぶんだけ間隔を空ける。思考ループが次の行動を決めれば
			// そこで 0 に戻るので、待ちが積み上がったままにはならない。
			const idleBackoff = Math.min(8000, this.instantRepeats * 1000);
			await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500 + idleBackoff));
		}
	}

	private async checkCombatStatus() {
		// pvp プラグインと bot.entities に依存するため Java 版限定
		if (!this.isJava) {
			this.isInCombat = false;
			return;
		}
		const pvpBot = this.bot as any;

		if (pvpBot.pvp?.target) {
			this.isInCombat = true;
			return;
		}

		const nearbyHostiles = [];
		if (!this.bot.entity) {
			this.isInCombat = false;
			return;
		}
		for (const id in this.bot.entities) {
			const e = this.bot.entities[id];
			if (e.type !== "mob" && e.type !== "hostile") continue;
			if (e.position.distanceTo(this.bot.entity.position) < 16) {
				nearbyHostiles.push(e);
			}
		}

		if (nearbyHostiles.length > 0) {
			this.enterCombat(nearbyHostiles[0]);
			return;
		}

		if (this.isInCombat) {
			this.exitCombat();
		}
	}

	private async startThinkingLoop() {
		while (this.driver.getState().isReady) {
			try {
				const state = await this.getAgentStateForThinking();
				const prompt = buildThinkingPrompt(state);

				this.log("🧠 Thinking...");

				const rawOutput = await llm.complete(prompt);

				// Log saving
				const safeName = path.basename(this.profile.minecraftName);
				const logDir = path.join(process.cwd(), "logs", safeName);
				if (!fs.existsSync(logDir)) {
					fs.mkdirSync(logDir, { recursive: true });
				}
				const inputPath = path.join(logDir, "input.md");
				const outputPath = path.join(logDir, "output.md");
				fs.writeFileSync(inputPath, prompt);
				fs.writeFileSync(outputPath, rawOutput || "");

				const parsed = parseLlmOutput(rawOutput);
				await this.applyThoughtResult(parsed);
				this.thinkFailures = 0;
			} catch (err) {
				this.thinkFailures++;
				this.log(`Thinking error: ${err}`);
				// 脳が落ちている間、行動を選び直す者が誰もいなくなる。
				// 反射ループは currentTaskName をひたすら回すだけなので、
				// goto.surface のような「もう条件を満たしている」と即答する
				// スキルを掴んでいると、何時間でも空回りする。
				// 選べないなら、せめて選び直す。
				if (this.thinkFailures >= THINK_FAILURE_TOLERANCE) this.pickSkillWithoutBrain();
			}

			// 途中で起こされたら待たずに次を考える。
			//
			// 落ちている間は間隔を広げる。10秒で接続に失敗するので、30秒ごとに
			// 叩き続けるとログがそればかりになる。復帰を取りこぼさない程度に
			// 抑える(上限 THINK_RETRY_MAX_MS)。
			const wait =
				this.thinkFailures > 0
					? Math.min(THINK_RETRY_MAX_MS, 30000 * 2 ** Math.min(this.thinkFailures - 1, 3))
					: 30000;
			// 起こされても、最短間隔(THINK_MIN_GAP_MS)は空ける。
			//
			// スキルの失敗や反射の手放しで即座に考え直す仕組みにしたので、
			// 3秒おきに失敗する行動があると、そのたびに LLM を叩くことになる。
			// 間隔の下限を置き、その間に来た起こしは1回にまとめて持ち越す。
			await new Promise<void>((resolve) => {
				let woken = this.wakePending;
				this.wakePending = false;
				let gapPassed = false;
				const finish = () => {
					this.wakeThinking = null;
					resolve();
				};
				const timer = setTimeout(finish, wait);
				const gap = setTimeout(() => {
					gapPassed = true;
					if (woken) {
						clearTimeout(timer);
						finish();
					}
				}, THINK_MIN_GAP_MS);
				this.wakeThinking = () => {
					woken = true;
					if (gapPassed) {
						clearTimeout(timer);
						clearTimeout(gap);
						finish();
					}
				};
			});
		}
	}

	/**
	 * 脳が落ちている間の行動選び。
	 *
	 * LLM が答えないとき、currentTaskName は最後に選ばれたまま固定される。
	 * 反射ループはそれを回し続けるので、一瞬で終わるスキルを掴んでいると
	 * 空回りが止まらない。実測 2026-09-11 は 6時間52分で goto.surface を
	 * 2184回、他は explore_land が230回だけだった。
	 *
	 * 賢く選ぶ必要はない。「同じものを回し続けない」ことと「前提が明らかに
	 * 満たせないものを選ばない」ことだけ守れば、脳が戻るまで持ちこたえる。
	 */
	private pickSkillWithoutBrain(): void {
		const candidates = Array.from(this.skills.keys()).filter((name) => {
			if (name === this.currentTaskName) return false;
			if (!this.skillIsWorthOffering(name)) return false;
			// 脳が無いときだけは、前提が欠けているものも選ばない。判断できない
			// 状態で選び直しても同じ失敗になるだけ。
			if (this.skillPrecondition(name) !== null) return false;
			// 何度試しても駄目だったものを、判断できない状態で選び直しても同じ。
			const rel = this.skillReliability(name);
			return !(rel && rel.tried >= 3 && rel.rate < 0.2);
		});
		if (candidates.length === 0) return;

		const next = candidates[Math.floor(Math.random() * candidates.length)];
		this.log(`[思考停止] LLM に繋がらないので ${next} に切り替える`);
		this.currentTaskName = next;
		this.currentTaskStartY = Math.floor(this.driver.getState().position.y);
		this.currentTaskSince = Date.now();
		this.instantRepeats = 0;
	}

	private async getAgentStateForThinking() {
		const skillsContext = Array.from(this.skills.values())
			// いま成立しないものは見せない。見せれば LLM は選び、即失敗して
			// 枠を1つ潰す。実測で collecting.hunting が周りに動物がいないのに
			// 20回選ばれ、goto.death_point が落とし物も無いのに20回選ばれた。
			// 前提が満たせるかどうかは、こちらで分かるものはこちらで判断する。
			.filter((t) => this.skillIsWorthOffering(t.name))
			.map((t) => {
				const hasArgs = t.inputSchema && Object.keys(t.inputSchema).length > 0;
				const argsInfo = hasArgs
					? Object.entries(t.inputSchema)
							.map(([k, v]) => `${k}: ${(v as any).description}`)
							.join(", ")
					: "";
				// これまでの実績を添える。うまくいっていない手段を避けられる。
				const rel = this.skillReliability(t.name);
				// 「成功」は目的を果たした回数、「progress」は世界が変わった(物を得た・
				// 動いた・登った)回数。登坂は 0% success でも progress が付く。捨てて
				// よいのは、成功もせず進みもしないものだけ。
				const note =
					rel && rel.tried >= 3
						? ` [tried ${rel.tried} times, ${Math.round(rel.rate * 100)}% success, ${
								rel.progressed
							} made progress${
								rel.rate < 0.2 && rel.progressed / rel.tried < 0.3
									? "; almost always fails here and gets nowhere, try something else first"
									: rel.rate < 0.2
										? "; it has not finished yet but it IS making progress — repeated calls continue it"
										: ""
							}]`
						: "";
				// 前提が欠けているなら、外さずに書く。選ぶのは LLM。
				const unmet = this.skillPrecondition(t.name);
				const precondition = unmet ? ` [PRECONDITION UNMET: ${unmet}]` : "";
				return {
					name: t.name,
					description: t.description + precondition + note,
					args: argsInfo,
				};
			});

		const historyText = this.getHistoryContext();
		const inventory =
			this.driver.inventory
				.items()
				.map((i) => `${i.name} x${i.count}`)
				.join(", ") || "Empty";

		const heldItem = this.driver.inventory.heldItem()?.name ?? "bare_hands";

		// 会話の履歴は行動側へ渡さない。喋るのは別系統(conversation.ts)の
		// 仕事で、そこから行動に変えるべきものだけが pendingRequest として来る。
		const pendingRequest = this.getPendingRequest() ?? undefined;

		// Use perception module
		const perception = createPerceptionSnapshot(this.driver, this.lastDamageCause);

		// Nearby blocks sampling (radius 8, random 10 points)
		const sampleRadius = 8;
		const sampledBlocks: string[] = [];
		if (!this.driver.getState().isReady) {
			return {
				profile: {
					name: this.profile.minecraftName,
					personality: this.profile.personality,
					chatLanguage: this.profile.chatLanguage,
				},
				environment: {
					biome: "unknown",
					timeOfDay: "day",
					weather: "clear",
					lightLevel: null,
					health: 0,
					hunger: 0,
					position: { x: 0, y: 0, z: 0 },
					nearbyPlayers: [],
					nearbyMobs: [],
					nearbyBlocks: "None",
					heldItem: "bare_hands",
				},
				inventorySummary: "Empty",
				strategies: [],
				achievements: [],
				bases: [],
				skills: skillsContext,
				pendingRequest,
				lastDamageCause: this.lastDamageCause,
				memorySummary: historyText,
			};
		}
		// 統合版は world 未実装なので、引けない場合は周辺ブロックなしとして扱う
		const origin = this.driver.getState().position;
		for (let i = 0; i < 10; i++) {
			const dx = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			const dy = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			const dz = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			try {
				const block = this.driver.world.blockAt({
					x: Math.floor(origin.x) + dx,
					y: Math.floor(origin.y) + dy,
					z: Math.floor(origin.z) + dz,
				});
				if (block && block.name !== "air") {
					sampledBlocks.push(block.name);
				}
			} catch {
				break;
			}
		}
		const nearbyBlocksText = [...new Set(sampledBlocks)].slice(0, 10).join(", ") || "None";

		return {
			profile: {
				name: this.profile.minecraftName,
				personality: this.profile.personality,
				chatLanguage: this.profile.chatLanguage,
			},
			environment: {
				biome: perception.environment.biome,
				timeOfDay: perception.environment.timeOfDay,
				weather: perception.environment.weather,
				lightLevel: perception.environment.lightLevel,
				health: perception.health,
				hunger: perception.food,
				position: {
					x: Math.floor(perception.position.x),
					y: Math.floor(perception.position.y),
					z: Math.floor(perception.position.z),
				},
				nearbyPlayers: perception.environment.nearbyPlayers,
				nearbyMobs: perception.environment.nearbyMobs.map((m) => `${m.name}(${m.distance}m)`),
				nearbyBlocks: nearbyBlocksText,
				heldItem: heldItem,
			},
			inventorySummary: inventory,
			strategies: this.strategicState.strategies,
			achievements: this.strategicState.achievements,
			bases: this.bases.map(
				(b) =>
					`${b.id} (${b.type}) at (${b.position.x}, ${b.position.y}, ${b.position.z}) | safe: ${b.safe}, functional: ${b.functional}, storage: ${b.hasStorage}`,
			),
			// 見かけた建物を渡す。行き先の候補がこれしか無いことも多い。
			//
			// 高さの差も必ず添える。水平距離だけ書くと、地下 Y=1 から
			// 「作業台まで10ブロック」と読めてしまい、実際は真上に65ブロック
			// ある、という誤解になる。地下にいる間は「まず地上へ出る」が
			// 正しい判断なので、そこが伝わらないと選択を誤る。
			landmarks: this.getKnownLandmarks()
				.slice(0, 5)
				.map((l) => {
					const d = Math.hypot(l.position.x - origin.x, l.position.z - origin.z);
					const dy = Math.round(l.position.y - origin.y);
					const vertical =
						dy > 1 ? `, ${dy} blocks above you` : dy < -1 ? `, ${-dy} blocks below you` : "";
					return `${l.name} at (${l.position.x}, ${l.position.y}, ${l.position.z}) — ${Math.round(d)} blocks away horizontally${vertical}`;
				}),
			spawnBed: this.describeSpawnPoint(),
			hazardZones: this.hazardZones.map((z) => {
				const d = Math.hypot(z.x - origin.x, z.z - origin.z);
				const where =
					d <= z.radius
						? "YOU ARE INSIDE IT"
						: `${Math.round(d - z.radius)} blocks outside its edge`;
				return `centered (${z.x}, ${z.z}) radius ${z.radius} — ${where}`;
			}),
			skills: skillsContext,
			// 判断の材料。以前はこれらの事実をコード側が読んで担当を決めていた。
			// 決めるのは LLM で、ここは事実を欠かさず渡す。
			situation: await this.describeSituationForThinking(),
			// 反射が前の思考以降にしたこと。読んだら消える。
			reflexLog: this.reflexLog.flush(),
			currentAction: this.describeCurrentAction(),
			stance: this.stance,
			hideDeclined: Date.now() < this.shelterDeclinedUntil,
			hideHeld: this.shelterLatch !== null,
			stallNotes: this.getStallNotes(),
			allowSpontaneousChat: process.env.ENABLE_CHAT === "1",
			pendingRequest,
			lastDamageCause: this.lastDamageCause,
			memorySummary: historyText,
		};
	}

	/**
	 * いまの状況を、判断に使える文にして返す。
	 *
	 * 事実は反射が見ているのと同じ snapshot から取る。反射が知っていて
	 * LLM が知らない事実、という差を作らないため。
	 */
	/**
	 * 復帰地点の説明。どこに生まれ直すかは、死ぬたびの出発点を決める事実。
	 *
	 * 登録が無いときの復帰先はワールドスポーンで、その座標はサーバーから
	 * 来ない。分かっているのは「直前に生まれ直した場所」なので、それを使う。
	 * 危険域の中なら、そう言う。ベッドで動かせることも添える(手段の存在を
	 * 知らなければ選べない)。
	 */
	private describeSpawnPoint(): string | undefined {
		const fix = `Move it with building.bed: craft a bed (${BED_WOOL_COUNT} wool of one color + 3 planks) and place it on the surface OUTSIDE the hazard zone.`;
		if (this.spawnBed) {
			const p = this.spawnBed;
			return this.isInHazard(p)
				? `(${p.x}, ${p.y}, ${p.z}) — INSIDE the dug-out hazard zone: every death drops you back into the crater. ${fix}`
				: `(${p.x}, ${p.y}, ${p.z})`;
		}
		const last = this.lastRespawnPos;
		if (last && this.isInHazard(last)) {
			return `None registered. You last respawned at (${last.x}, ${last.y}, ${last.z}), INSIDE the dug-out hazard zone: every death drops you back into the crater. ${fix}`;
		}
		return undefined;
	}

	private async describeSituationForThinking(): Promise<string[]> {
		try {
			const s = await this.buildSurvivalSnapshot();
			const pos = this.driver.getState().position;
			const zone = hazardAt(this.hazardZones, pos);
			const items = this.driver.inventory.items();
			return describeSituation(s, {
				hazardExit: zone ? hazardExit(this.hazardZones, zone, pos) : null,
				wool: totalWool(items),
				bedWoolReady: pickBedWool(items) !== null,
				heightTrend: this.heightTrend(),
				frontier: (() => {
					const f = this.explorationFrontier();
					if (!f) return null;
					return {
						...f,
						distance: Math.round(Math.hypot(f.target.x - pos.x, f.target.z - pos.z)),
					};
				})(),
				rottenFlesh: items
					.filter((i) => i.name === "rotten_flesh")
					.reduce((n, i) => n + i.count, 0),
				droppedItems: this.driver
					.nearbyEntities(24)
					.filter((e) => e.kind === "item")
					.sort(
						(a, b) =>
							Math.hypot(a.position.x - pos.x, a.position.z - pos.z) -
							Math.hypot(b.position.x - pos.x, b.position.z - pos.z),
					)
					.map(
						(e) =>
							`${e.name}(${Math.round(Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z))}m)`,
					),
				stoneReach: this.stoneReach(),
				// 一覧から外した判定と同じものを使う。別々に書くとずれる。
				nothingToCraft: {
					weapon: craftingManager.determineNextWeapon(this) === null,
					tool: toolCraftingManager.determineNextSkill(this.driver) === null,
				},
				respawnInHazard:
					(this.spawnBed && this.isInHazard(this.spawnBed)) ||
					(!this.spawnBed && !!this.lastRespawnPos && this.isInHazard(this.lastRespawnPos)),
				lootNearRecentDeath: s.deathPoint ? this.isNearRecentDeath(s.deathPoint) : false,
				nightSurfaceDeaths: {
					night: this.deathFacts.filter((d) => d.night && d.surface).length,
					total: this.deathFacts.length,
				},
			});
		} catch (e) {
			this.log(`状況の言語化でつまずいた: ${e}`);
			return [];
		}
	}

	/**
	 * いま走っている行動の経過。続けるか替えるかは LLM が決めるので、材料を渡す。
	 */
	private describeCurrentAction(): string | undefined {
		if (!this.currentTaskName || !this.skills.has(this.currentTaskName)) return undefined;
		const owned =
			this.currentTaskSince > 0 ? Math.round((Date.now() - this.currentTaskSince) / 1000) : 0;
		const running =
			this.currentExecutionStartedAt > 0
				? Math.round((Date.now() - this.currentExecutionStartedAt) / 1000)
				: 0;
		const state = running > 0 ? `running for ${running}s now` : "between runs";
		// 登坂中は、担当し始めてから何段上がったかを添える。
		let climb = "";
		if (this.currentTaskStartY !== null) {
			const dy = Math.floor(this.driver.getState().position.y) - this.currentTaskStartY;
			if (dy !== 0) {
				climb = ` Since you started it your height changed by ${dy > 0 ? "+" : ""}${dy} blocks.`;
			}
		}
		return `${this.currentTaskName} — you have been on it for ${owned}s (${state}).${climb} Choosing it again lets it continue; choosing anything else interrupts it. Long actions (climbing out, walking somewhere) need more than one thought to finish.`;
	}

	/** 高さを控える。15分ぶん持つ。あわせて訪れた格子も数える。 */
	private sampleHeight(): void {
		const state = this.driver.getState();
		if (!state.isReady) return;
		const now = Date.now();
		this.noteVisit(state.position, now);
		this.heightSamples.push({ at: now, y: Math.floor(state.position.y) });
		const cutoff = now - 15 * 60_000;
		while (this.heightSamples.length > 0 && this.heightSamples[0].at < cutoff) {
			this.heightSamples.shift();
		}
	}

	/** 訪れた格子を数える。60 秒ごとにディスクへ控える(再起動しても未踏の判断が続く)。 */
	private noteVisit(pos: Position, now: number): void {
		const key = `${Math.floor(pos.x / VISIT_CELL)},${Math.floor(pos.z / VISIT_CELL)}`;
		this.visitCells.set(key, (this.visitCells.get(key) ?? 0) + 1);
		this.visitsDirty = true;
		if (now - this.lastVisitSaveAt > 60_000) {
			this.lastVisitSaveAt = now;
			this.saveVisits();
		}
	}

	private saveVisits(): void {
		if (!this.visitsDirty) return;
		this.visitsDirty = false;
		try {
			const file = path.join(process.cwd(), VISITS_FILE);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ cell: VISIT_CELL, visits: [...this.visitCells] }));
		} catch {
			// 書けなくても行動は続く。
		}
	}

	private loadVisits(): void {
		try {
			const file = path.join(process.cwd(), VISITS_FILE);
			if (!fs.existsSync(file)) return;
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (raw?.cell !== VISIT_CELL || !Array.isArray(raw.visits)) return;
			for (const [k, n] of raw.visits) {
				if (typeof k === "string" && typeof n === "number") this.visitCells.set(k, n);
			}
		} catch {
			// 壊れていたら無かったことにする。
		}
	}

	/**
	 * 未踏の方向と、そこに置く目標点。初期リスから見た 8 方位のうち、扇形
	 * (半径 64 より外)への訪問が一番少ないものを選び、目標点は最大到達距離
	 * + 150 の先(200〜800 に収める)。同数なら今いる場所から近い方。スキル
	 * (explore の向き)と SITUATION の両方が使う。
	 */
	public explorationFrontier(): {
		target: { x: number; z: number };
		visitsNear: number;
		farthest: number;
	} | null {
		if (this.visitCells.size === 0) return null;
		const cells = [...this.visitCells].map(([k, n]) => {
			const [cx, cz] = k.split(",").map(Number);
			return { x: cx * VISIT_CELL + VISIT_CELL / 2, z: cz * VISIT_CELL + VISIT_CELL / 2, n };
		});
		let farthest = 0;
		for (const c of cells) {
			farthest = Math.max(farthest, Math.hypot(c.x - SPAWN_X, c.z - SPAWN_Z));
		}
		const radius = Math.min(
			FRONTIER_MAX_RADIUS,
			Math.max(FRONTIER_MIN_RADIUS, Math.round(farthest + FRONTIER_STEP)),
		);
		const here = this.driver.getState().position;
		const sector = (2 * Math.PI) / FRONTIER_DIRECTIONS;
		let best: { target: { x: number; z: number }; visitsNear: number; near: number } | null = null;
		for (let i = 0; i < FRONTIER_DIRECTIONS; i++) {
			const angle = i * sector;
			const target = {
				x: Math.round(SPAWN_X + Math.cos(angle) * radius),
				z: Math.round(SPAWN_Z + Math.sin(angle) * radius),
			};
			// この方位の扇形にどれだけ行ったか。初期リスのすぐ周りは全方位に
			// 数えられてしまうので、半径 64 より外だけ見る。
			let visitsNear = 0;
			for (const c of cells) {
				const dx = c.x - SPAWN_X;
				const dz = c.z - SPAWN_Z;
				if (Math.hypot(dx, dz) <= FRONTIER_NEAR_IGNORE) continue;
				let diff = Math.atan2(dz, dx) - angle;
				while (diff > Math.PI) diff -= 2 * Math.PI;
				while (diff < -Math.PI) diff += 2 * Math.PI;
				if (Math.abs(diff) <= sector / 2) visitsNear += c.n;
			}
			const near = Math.hypot(target.x - here.x, target.z - here.z);
			if (
				!best ||
				visitsNear < best.visitsNear ||
				(visitsNear === best.visitsNear && near < best.near)
			) {
				best = { target, visitsNear, near };
			}
		}
		return best
			? { target: best.target, visitsNear: best.visitsNear, farthest: Math.round(farthest) }
			: null;
	}

	/** 直近の高さの推移。地下で行き来しているかを LLM に見せる材料。 */
	private heightTrend(): {
		minutes: number;
		from: number;
		to: number;
		low: number;
		high: number;
	} | null {
		if (this.heightSamples.length < 2) return null;
		const first = this.heightSamples[0];
		const last = this.heightSamples[this.heightSamples.length - 1];
		const minutes = Math.round((last.at - first.at) / 60_000);
		if (minutes < 3) return null;
		let low = Number.POSITIVE_INFINITY;
		let high = Number.NEGATIVE_INFINITY;
		for (const s of this.heightSamples) {
			if (s.y < low) low = s.y;
			if (s.y > high) high = s.y;
		}
		return { minutes, from: first.y, to: last.y, low, high };
	}

	private async applyThoughtResult(result: any) {
		// 方針は「積み上げる」ものではなく「今の方針」なので、書き換える。
		//
		// 以前は FIFO に追加していた。プロンプトは毎周「update or keep current」と
		// 尋ねるので、モデルは毎回ほぼ同じことを言い直す。少しずつ違う文面が
		// 3枠を埋め、本当に別の方針が出てきても押し出す枠が無い、という状態に
		// なっていた。実測では
		//   - 安全な場所へ移動する
		//   - 安全な場所へ移動し、木材を集めて木の剣を作る。
		//   - 安全な場所へ移動し、木材を集める
		// の3本が固定され、長時間まったく更新されていない。
		// 言い直しかどうかを測るより、毎回入れ替える方が素直で、
		// プロンプトの文面とも一致する。
		// 敵が近いときの構え。サイドカーの毎tick反射が読む。書かれていなければ変えない。
		if (result.stance && result.stance !== this.stance) {
			this.stance = result.stance;
			this.log(`[反射] LLM が構えを ${result.stance} にした`);
			this.driver.setStance(result.stance).catch((e) => this.log(`構えの送信に失敗: ${e}`));
		}

		// 反射 shelter のオンオフ。LLM が唯一、反射を直接切れる経路。
		if (result.hide === false) {
			if (this.shelterLatch) {
				this.log("[反射] 籠り中なので Hide: no は無視する(夜明けか被弾まで)");
			} else if (Date.now() >= this.shelterDeclinedUntil) {
				this.log("[反射] LLM が籠りを断った。瀕死でない限り、夜でも潜らない");
			}
			this.shelterDeclinedUntil = Date.now() + SHELTER_DECLINE_TTL_MS;
		} else if (result.hide === true) {
			if (this.shelterDeclinedUntil > 0) this.log("[反射] LLM が籠りを許した");
			this.shelterDeclinedUntil = 0;
			this.shelterApprovedUntil = Date.now() + SHELTER_DECLINE_TTL_MS;
			// LLM が籠ると言ったなら、被弾後の待ちは要らない。
			this.shelterLatchBlockedUntil = 0;
		}

		const strategy: string[] = Array.isArray(result.strategy) ? result.strategy : [];
		if (strategy.length > 0) {
			this.strategicState.strategies = strategy.slice(0, MAX_STRATEGIES);
		}

		// 実績は履歴なので、こちらは積む。同じ文面は updateFIFO が弾く。
		const achievement: string[] = Array.isArray(result.achievement) ? result.achievement : [];
		for (const line of achievement) {
			this.updateFIFO(this.strategicState.achievements, line);
		}

		// この判断で使い切る。次の周からは通常の猶予に戻す。
		// 以降は this.humanRequestPending ではなくこの控えを見ること。
		// ここで false に戻すので、後段で参照しても必ず偽になる。
		const wasHumanRequest = this.humanRequestPending;
		this.humanRequestPending = false;

		const rationale = result.memory || "No reasoning.";
		const foundSkillName = result.action?.name;
		const parsedArgs = this.nameParsedArgs(
			foundSkillName,
			result.action?.args || {},
			result.action?.positional || [],
		);

		// 中断の要否を引数の変化でも判断するので、上書きする前に控える。
		const previousArgs = foundSkillName ? this.currentSkillArgs[foundSkillName] : undefined;

		if (foundSkillName) {
			this.currentSkillArgs[foundSkillName] = parsedArgs;
		}

		this.log(`${foundSkillName ?? "no-skill"} ${rationale}`);

		// 話しかけへの返答は conversation が担当する。ここで喋るのは
		// ENABLE_CHAT=1 のときの自発的な発言（複数体で会話させる場合）だけ。
		// 両方が喋ると、1つの問いかけに2回answerする。
		const chatMessage = result.speak || "";
		if (process.env.ENABLE_CHAT === "1" && chatMessage) {
			const isNewChat = !isSameSimhash(
				chatMessage,
				this.profile.minecraftName,
				this.chatSimhashCache,
			);
			if (isNewChat && this.updateFIFO(this.strategicState.chats, chatMessage)) {
				// 独り言なので宛先は無い。宛先を渡すと、返事でもないのに
				// 「続きの返信」の枠が開いてしまう。
				await this.speak(chatMessage, null);
			}
		}

		const pickBlockedReason =
			foundSkillName && this.skills.has(foundSkillName)
				? this.skillBlockedReason(foundSkillName)
				: null;
		if (foundSkillName && pickBlockedReason) {
			// 候補から外したスキルでも、LLM は SITUATION や履歴から名前を拾って
			// 選ぶ(実測 2026-09-21 09:14、満腹 20/20 で survival.eat を 10 秒に 3 回)。
			// 走らせても即失敗するだけなので、理由を履歴に載せて返す。
			//
			// 「担当中のものは通す」(currentTaskName !== foundSkillName)は外した。
			// 1回目で currentTaskName になった後は選び直すたびにここを素通りし、
			// この注記が狙っていた「10 秒に 3 回」がそのまま通っていた。実測
			// 2026-09-22 集計(run-160〜174)、前提で弾けたのが 82 回に対し、
			// すり抜けて実行され "Hunger is already full (20/20); you cannot eat
			// now." で失敗したのが 42 回。12:25:18/22/27 のように数秒間隔で並ぶ。
			//
			// ここで返しても実行中のものは止まらない(currentTaskName を触らずに
			// return するだけ)。止めるのではなく、選び直しを断るだけの場所。
			// 実行ループ側のガードと同じ判定にする。ずれていると、片方が弾いて
			// もう片方が通すので「弾く→即再考→また同じものを選ぶ」で往復する。
			const reason = pickBlockedReason;
			this.log(`[思考] いま成立しない ${foundSkillName} を選んだ: ${reason}`);
			this.pushHistory({
				action: foundSkillName,
				rationale,
				result: "Fail",
				message: `Not available right now: ${reason}. Pick another skill.`,
			});
			return;
		}

		if (foundSkillName && this.skills.has(foundSkillName)) {
			// 同じスキルを同じ引数で選び直しただけなら、実行中のものを続けさせる。
			// 無条件に中断すると、思考ループの間隔(30秒)より長くかかる行動が
			// 構造的に完了できない。本番の Realm で goto.surface が5回とも
			// 29,28,28,29,29秒で中断され、一度も地表に着けなかったのがこれ。
			const isSameTask =
				this.currentTaskName === foundSkillName &&
				JSON.stringify(previousArgs ?? {}) === JSON.stringify(parsedArgs);
			const runningMs =
				this.currentExecutionStartedAt > 0 ? Date.now() - this.currentExecutionStartedAt : 0;
			const ranTooLong = runningMs > MAX_UNINTERRUPTED_MS;

			// 担当し始めたばかりの行動は、別の行動のために止めない。
			// 30秒では終わらない行動が最初からやり直しになり続けるため。
			//
			// 「今の実行の経過」ではなく「そのスキルを担当してからの経過」で測る。
			// 実行ごとに測ると、16秒で終わって再実行される exploring.explore_land の
			// ような短い行動が常に猶予内に入り、永久に乗り換えられなくなる。
			const owningMs = this.currentTaskSince > 0 ? Date.now() - this.currentTaskSince : 0;
			// 人に話しかけられた直後の判断は待たせない。指示に従うのが遅れると
			// 何度も言い直させることになる。
			// 空振りを繰り返しているものは猶予で守らない。猶予は「時間のかかる
			// 行動を最後までやらせる」ためのもので、一瞬で失敗し続ける行動を
			// 抱え込むためではない。実測で collecting.hunting が10分に149回
			// 即失敗し、その間ほかの行動が一切選ばれなかった。
			// ここにあった taskLock は無くした。
			//
			// 「地上へ戻る」のような前提条件は、LLM の乗り換えを握りつぶして
			// 守るのではなく、生存側が自分で回すようになった(surface ルール)。
			// 握りつぶす形は実測で1セッション232〜897回に達し、掴んでいる
			// goto.surface が壊れていても3分守り続ける罠になっていた。

			// 乗り換えの猶予(旧 MIN_UNINTERRUPTED_MS)は無くした。「担当してから60秒
			// 未満なら別の行動を却下する」のはコード側の判断で、LLM が選んだ
			// 行動を黙って捨てていた。いまは走っている行動の経過を CURRENT ACTION
			// として LLM に渡し、続けるか替えるかを LLM に言わせる。
			// 同じスキルを選び直せば続き、別を選べば止まる。それだけ。
			void owningMs;
			void wasHumanRequest;

			if (!isSameTask || ranTooLong) {
				if (isSameTask) {
					this.log(`${foundSkillName} が長すぎるため中断します`);
				}
				this.cancelCurrentExecution();
			}
			if (this.currentTaskName !== foundSkillName) {
				this.currentTaskName = foundSkillName;
				this.currentTaskStartY = Math.floor(this.driver.getState().position.y);
				this.currentTaskSince = Date.now();
				this.instantRepeats = 0;
				this.latestRationale = rationale;

				const now = Date.now();
				const isNewRationale = !isSameSimhash(
					rationale,
					`rationale:${this.profile.minecraftName}`,
					this.rationaleSimhashCache,
				);
				if (
					process.env.DISCORD_WEBHOOK_URL &&
					now - lastDiscordEmitAt >= 30_000 &&
					isNewRationale
				) {
					lastDiscordEmitAt = now;
					translateWithRoleplay(rationale, this.profile).then((translatedText) =>
						emitDiscordWebhook({
							username: this.profile.displayName,
							content: `**Action:** \`${foundSkillName}\`\n**Thought:** ${translatedText}${chatMessage === "" ? "" : `\n**Chat:** ${chatMessage}`}`,
							avatar_url: this.profile.avatarUrl,
						}),
					);
				}
			}
		} else if (foundSkillName) {
			// 無いスキルを選んだ。黙って前の行動を続けると、LLM は失敗を知らずに
			// 同じ名前を選び続ける(実測 2026-09-21 07:35〜07:40、crafting.helmet を
			// 29 回の思考のうち 16 回。木の防具は存在しないし、防具を作るスキルも
			// 無い)。失敗として履歴に載せ、呼べる名前を返す。
			const names = [...this.skills.keys()].join(", ");
			const armor = /armor|helmet|chestplate|leggings|boots/i.test(foundSkillName);
			this.log(`[思考] 存在しないスキル ${foundSkillName} を選んだ`);
			this.pushHistory({
				action: foundSkillName,
				rationale,
				result: "Fail",
				message: `No such skill. The only skills you can call are: ${names}.${
					armor
						? " None of them crafts armor (and wooden armor does not exist in Minecraft); do not plan around armor."
						: ""
				}`,
			});
		}
	}

	/**
	 * キー名の無い引数にスキル定義の名前を割り当てる。
	 *
	 * `goto.coords(586, 0, -923)` のように位置引数だけで書かれると、パーサは
	 * 値の並びしか返せない。どの名前に対応するかを知っているのは inputSchema
	 * だけなので、突き合わせはここで行う。名前付きの引数が既にあるときは
	 * そちらを信じて何もしない。
	 */
	private nameParsedArgs(
		skillName: string | undefined,
		args: Record<string, any>,
		positional: unknown[],
	): Record<string, any> {
		if (!skillName || positional.length === 0 || Object.keys(args).length > 0) return args;

		const schema = this.skills.get(skillName)?.inputSchema;
		if (!schema) return args;

		// オブジェクトのキー順は定義順。inputSchema は x, y, z のように
		// 呼び出し順で書かれているので、そのまま対応させられる。
		const keys = Object.keys(schema);
		if (keys.length === 0) return args;

		const named: Record<string, any> = {};
		for (let i = 0; i < Math.min(keys.length, positional.length); i++) {
			named[keys[i]] = positional[i];
		}
		return named;
	}

	private cancelCurrentExecution() {
		// 生存側が担当を握っている間は止めない。
		//
		// ここは「思考が別の行動を選んだので、走っているものを止める」処理で、
		// 相手が思考の選んだスキルなら正しい。だが生存側の行動(狩り・退避・
		// 地上復帰)まで同じ合図で殺していた。狩りは20秒かけて獲物へ寄る行動
		// なので、30秒ごとの思考が来るたびに2〜7秒で刻まれ、一度も殴り切れない。
		// 担当には裁定者が期限を付けているので、待たせても止まりはしない。
		if (this.survivalHolding) {
			this.log("[生存] 担当中なので、思考の乗り換えでは中断しない");
			return;
		}
		if (this.currentAbort) {
			this.currentAbort.abort("New task assigned by thinking loop");
		}

		try {
			this.driver.stopMoving();
			this.driver.clearControlStates();
		} catch {}

		if (!this.isJava) return;

		try {
			this.bot.pathfinder.setGoal(null);
		} catch {}

		try {
			this.bot.pathfinder.stop();
		} catch {}

		try {
			this.bot.stopDigging();
		} catch {}
	}

	private isMoving: boolean = false;

	public checkAbort(signal: AbortSignal): boolean {
		if (signal.aborted) {
			this.log("Abort detected, stopping execution...");
			return true;
		}
		return false;
	}

	public addBase(base: {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	}): boolean {
		const MIN_DISTANCE = 50;
		for (const existing of this.bases) {
			const dist =
				Math.abs(existing.position.x - base.position.x) +
				Math.abs(existing.position.z - base.position.z);
			if (dist < MIN_DISTANCE) {
				this.log(`Base too close to existing base (${dist} < ${MIN_DISTANCE}), not adding.`);
				return false;
			}
		}
		if (this.bases.length >= 3) {
			this.bases.shift();
		}
		this.bases.push(base);
		this.log(
			`Added base: ${base.id} at (${base.position.x}, ${base.position.y}, ${base.position.z})`,
		);
		return true;
	}

	public getBases() {
		return this.bases;
	}

	public upsertBase(base: {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	}): boolean {
		const MIN_DISTANCE = 50;
		const existingIndex = this.bases.findIndex((b) => b.id === base.id);
		if (existingIndex >= 0) {
			this.bases[existingIndex] = base;
			this.log(
				`Updated base: ${base.id} at (${base.position.x}, ${base.position.y}, ${base.position.z})`,
			);
			return true;
		}
		for (const existing of this.bases) {
			const dist =
				Math.abs(existing.position.x - base.position.x) +
				Math.abs(existing.position.z - base.position.z);
			if (dist < MIN_DISTANCE) {
				this.log(`Base too close to existing base (${dist} < ${MIN_DISTANCE}), not adding.`);
				return false;
			}
		}
		if (this.bases.length >= 3) {
			this.bases.shift();
		}
		this.bases.push(base);
		this.log(
			`Added base: ${base.id} at (${base.position.x}, ${base.position.y}, ${base.position.z})`,
		);
		return true;
	}

	public getNearestBase(): {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	} | null {
		if (this.bases.length === 0) return null;
		const state = this.driver.getState();
		if (!state.isReady) return null;
		const pos = state.position;
		let nearest = this.bases[0];
		let minDist = Infinity;
		for (const base of this.bases) {
			const dist = Math.abs(base.position.x - pos.x) + Math.abs(base.position.z - pos.z);
			if (dist < minDist) {
				minDist = dist;
				nearest = base;
			}
		}
		return nearest;
	}

	public async abortableSetControlState(
		signal: AbortSignal,
		control: ControlState,
		value: boolean,
	): Promise<void> {
		const { bot } = this;

		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}
		bot.setControlState(control, value);
	}

	public async abortableDig(signal: AbortSignal, block: any): Promise<void> {
		const { bot } = this;

		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}
		const p = new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				bot.stopDigging();
				reject(new Error("Aborted"));
			};

			if (signal?.aborted) {
				onAbort();
				return;
			}

			const abortHandler = () => onAbort();
			signal?.addEventListener("abort", abortHandler);

			bot.once("blockBreakProgressObserved", () => {
				if (this.checkAbort(signal)) {
					bot.stopDigging();
				}
			});

			bot.once("diggingCompleted", () => {
				signal?.removeEventListener("abort", abortHandler);
				resolve();
			});

			bot.once("diggingAborted", () => {
				signal?.removeEventListener("abort", abortHandler);
				reject(new Error("Digging aborted"));
			});

			bot
				.dig(block)
				.then(() => {
					signal?.removeEventListener("abort", abortHandler);
					resolve();
				})
				.catch((err) => {
					signal?.removeEventListener("abort", abortHandler);
					reject(err);
				});
		});

		while (true) {
			if (this.checkAbort(signal)) {
				throw new Error("Aborted");
			}
			try {
				await p;
				return;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw err;
				}
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
					throw new Error("Aborted");
				}
				throw err;
			}
		}
	}

	public async abortableAttack(signal: AbortSignal, target: any): Promise<void> {
		const { bot } = this;

		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}

		const attackLoop = async () => {
			while (true) {
				if (this.checkAbort(signal)) {
					throw new Error("Aborted");
				}
				try {
					await bot.attack(target);
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					if (errorMsg.includes("Cancelled") || errorMsg.includes("stop")) {
						throw new Error("Aborted");
					}
				}
				await new Promise((r) => setTimeout(r, 250));
			}
		};

		const attackPromise = attackLoop();

		// 中断されたら止める。ここで bot.attack(target) を呼んでいたので、
		// 「やめろ」と言われた瞬間にもう一発殴っていた。攻撃の停止は
		// pvp プラグイン側に持たせる。
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					try {
						(bot as any).pvp?.stop();
					} catch {}
				},
				{ once: true },
			);
		}

		return attackPromise;
	}

	public async abortableGoto(signal: AbortSignal, goal: goals.Goal): Promise<void> {
		const { bot } = this;

		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}

		if ((this.currentGoal as any)?.equals?.(goal)) {
			return;
		}

		this.currentGoal = goal;

		if (this.isMoving) {
			bot.pathfinder.stop();
			bot.clearControlStates();
			await new Promise((r) => setTimeout(r, 200));
		}

		this.isMoving = true;

		if (!bot.entity) {
			this.isMoving = false;
			return;
		}
		const startPos = bot.entity.position.clone();
		let lastPos = startPos.clone();
		let stuckCount = 0;
		const checkStuck = setInterval(() => {
			if (this.checkAbort(signal)) {
				clearInterval(checkStuck);
				return;
			}
			if (!bot.entity) return;
			const currentPos = bot.entity.position;
			if (currentPos.distanceTo(lastPos) < 0.05) {
				stuckCount++;
			} else {
				stuckCount = 0;
			}
			if (stuckCount >= 2) {
				this.log(`Pathfinding: Stuck detected...`);

				const pos = bot.entity.position;
				const block = bot.blockAt(pos);
				const inWater = block?.name === "water" || (bot.entity as any).isInWater;

				// 1. Pathfinderを停止
				const currentGoal = bot.pathfinder.goal;
				bot.pathfinder.setGoal(null);
				bot.clearControlStates();

				if (inWater) {
					this.log(`Pathfinding: Force water recovery initiated...`);

					// 1. 型エラーを回避しつつターゲットを特定
					const goal: any = bot.pathfinder.goal;
					let targetVec = null;
					if (goal && goal.x !== undefined) {
						targetVec = new (require("vec3"))(goal.x, goal.y ?? bot.entity.position.y, goal.z);
					}

					// 2. 物理スタック解消シーケンス
					// 目的地を向く
					if (targetVec) bot.lookAt(targetVec, true);

					// 一旦、斜め後ろに下がって「角」から完全に離れる
					const side = Math.random() > 0.5 ? "left" : "right";
					bot.setControlState("back", true);
					bot.setControlState(side as any, true);

					setTimeout(() => {
						bot.clearControlStates();

						// 3. 勢いをつけてジャンプ・スプリントで上陸を試みる
						if (targetVec) bot.lookAt(targetVec, true);
						bot.setControlState("forward", true);
						bot.setControlState("jump", true);
						bot.setControlState("sprint", true);

						setTimeout(() => {
							bot.clearControlStates();
							// 4. パスファインダーをリセットして再計算を強制
							if (currentGoal) {
								bot.pathfinder.setGoal(null); // 一度クリア
								setTimeout(() => bot.pathfinder.setGoal(currentGoal), 100);
							}
						}, 1500); // 滞空・上陸時間を長めに確保
					}, 500); // 下がる時間を0.5秒に延長
				} else {
					// 【陸上リカバリ】既存の「後ろに下がって斜めジャンプ」
					bot.setControlState("back", true);
					setTimeout(() => {
						bot.setControlState("back", false);
						bot.setControlState("jump", true);
						bot.setControlState("forward", true);
						bot.setControlState("right", true);

						setTimeout(() => {
							bot.clearControlStates();
							if (currentGoal) bot.pathfinder.setGoal(currentGoal);
						}, 400);
					}, 200);
				}
				stuckCount = 0;
			}
			lastPos = currentPos.clone();
		}, 300);

		let retry = 0;

		try {
			do {
				if (this.checkAbort(signal)) {
					throw new Error("Aborted");
				}
				try {
					await bot.pathfinder.goto(goal);
					this.log(`Pathfinding: Reached goal successfully!`);
					break;
				} catch (err) {
					this.log(`Pathfinding Error: ${err instanceof Error ? err.message : String(err)}`);
					this.log(`Pathfinding: Current pos after error: ${bot.entity.position}`);
					await new Promise((r) => setTimeout(r, 1000 * retry));
				}
				retry++;
			} while (retry < 3);
		} catch {
		} finally {
			clearInterval(checkStuck);
			this.isMoving = false;
			bot.clearControlStates();
		}
	}

	public async pickupNearbyItems(signal: AbortSignal): Promise<void> {
		const { bot } = this;

		if (!bot.entity) return;
		const distance = 8;
		const getNearestItem = () => {
			return Object.values(bot.entities).find(
				(e) =>
					e.name === "item" &&
					!!bot.entity &&
					bot.entity.position.distanceTo(e.position) < distance,
			);
		};

		let nearestItem = getNearestItem();
		let pickedUp = 0;

		while (nearestItem && pickedUp < 10) {
			try {
				await this.abortableGoto(signal, new goals.GoalFollow(nearestItem, 1));
				await new Promise((resolve) => setTimeout(resolve, 200));
				nearestItem = getNearestItem();
				pickedUp++;
			} catch {
				break;
			}
		}
	}

	/**
	 * LLM の判断を待たずに済ませる生存行動。
	 *
	 * 防具を着る・囲まれたら掘って出る、といった「考えるまでもないが、
	 * やらないと詰む」もの。思考ループは30秒に1回しか回らないので、
	 * ここに置かないと判断待ちの間ずっと不利なままになる。
	 * 本番のスポーン地点は壁に囲まれており、実際にそこで動けなくなっていた。
	 */
	/** 直前に書いた明るさ。値が動いたときだけ書く。 */
	private lastLoggedLight: number | null | undefined = undefined;
	/** 最後にログへ出した持ち物。変わったときだけ出す。 */
	private lastLoggedInventory = "";
	/** 手入れで最後に出た失敗。同じ文面を毎tick書かないための控え。 */
	private lastMaintenanceError = "";
	/** 直前に書いた時刻。値が細かく揺れても書き続けないようにする。 */
	private lastLightLogAt = 0;

	/**
	 * 明るさが変わったらログに残す。
	 *
	 * 統合版はサーバーが明るさを送ってこないため、ドライバは長いあいだ
	 * 15 固定を返していた。暗い所にいることがプロンプトにもログにも
	 * 残らず、「なぜ mob に殺され続けるのか」を後から追えなかった。
	 * 死因の6割が暗い所にしか湧かない相手なので、ここは残す価値がある。
	 */
	private noteDarkness(): void {
		const state = this.driver.getState();
		const light = this.driver.world.getLightLevel(state.position);
		if (light === this.lastLoggedLight) return;
		// 値が1ずつ揺れるだけでログを埋めないよう、間隔を空ける。
		if (Date.now() - this.lastLightLogAt < LIGHT_LOG_INTERVAL_MS) return;
		this.lastLoggedLight = light;
		this.lastLightLogAt = Date.now();

		const y = Math.floor(state.position.y);
		if (light === null) {
			this.log(`[明るさ] 不明（チャンク未読み込み） Y=${y}`);
			return;
		}
		// 高さと時刻も併記する。値が動かないとき、推定が壊れているのか
		// 本当に暗い所に居続けているのかを、ログだけで見分けられるようにする。
		const meaning = light <= 7 ? "暗い。mob が湧く" : "明るい";
		this.log(`[明るさ] ${light} — ${meaning} Y=${y} 時刻=${state.timeOfDay}`);
	}

	/**
	 * 持ち物が変わったらログに出す。
	 *
	 * 「剣を持っているのか、材料が無いだけなのか」を後から切り分けられない
	 * ログが続いた。crafting.weapon の「All combat equipment is already at
	 * the highest possible quality」は、最良の装備を持っているときと、
	 * 素材が無くて作れないときの両方で出る。実測 2026-09-17 00:48、
	 * どちらなのかログからは判別できなかった。持ち物は判断の根拠そのものなので、
	 * 変化だけでも残す。
	 */
	private noteInventory(): void {
		const state = this.driver.getState();
		if (!state.isReady) return;
		const items = this.driver.inventory.items();
		const worn = this.driver.inventory
			.armor()
			.filter((a) => a !== null)
			.map((a) => a?.name)
			.join(", ");
		const summary = items.map((i) => `${i.name} x${i.count}`).join(", ") || "空";
		const line = worn ? `${summary}（着用: ${worn}）` : summary;
		if (line === this.lastLoggedInventory) return;
		this.lastLoggedInventory = line;
		this.log(`[持ち物] ${line}`);
	}

	/**
	 * 生存のための手入れと判断。戻り値が true の間はスキル層を動かさない。
	 *
	 * 上半分は手入れで、拒否権も共有フラグも持たないので順不同でよい。
	 * 下半分の判断は裁定者が1つだけ選ぶ。以前はここに15個の反射が並び、
	 * それぞれが true を返して他を黙らせ、`sheltering` や `currentTaskName`
	 * を書き換えて隣に合図していた。その噛み合わせが実測で4時間26分の
	 * 停止を生んでいる(2026-09-17 07:10〜11:36)。
	 */
	private async reflexSurvival(signal: AbortSignal): Promise<boolean> {
		try {
			this.noteDarkness();
			this.noteInventory();
			// 手入れの失敗で判断を落とさない。
			//
			// wearBestArmor が status=49 を投げると下の catch まで飛び、
			// arbiter.tick も metrics.noteTick も走らないまま tick が終わる。
			// 実測 2026-09-21、run-165 で leather_boots を拾った次の行から
			// 181 回連続でこれが起き、その間の生存判断と計測が丸ごと欠けていた
			// (4本のログで計222回、全部 status=49)。上半分は拒否権を持たない
			// 約束なので、ここで握り潰して判断へ進む。
			try {
				await this.wearBestArmor();
				await this.equipBestWeapon();
				// 見かけた建物を控える。地上に出たとき、向かう先として使う。
				await this.noteLandmarksNearby();
				// 昼のうちにベッドを叩いてリスポーン地点を移しておく。
				await this.registerSpawnAtBed(signal);
			} catch (e) {
				// 毎tick同じ理由で落ちるので、文面が変わったときだけ書く。
				const msg = String(e);
				if (!signal.aborted && msg !== this.lastMaintenanceError) {
					this.lastMaintenanceError = msg;
					this.log(`[反射] 手入れでつまずいた(判断は続ける): ${msg}`);
				}
			}
			// 待たせず自分から動く。await しない: LLM 呼び出しを含むので、
			// ここで待つと反射ループそのものが詰まる。
			this.maybeGreetNearbyPlayer();

			this.releaseShelterLatchIfDue();
			this.sampleHeight();
			const snapshot = await this.buildSurvivalSnapshot();
			this.survivalHolding = true;
			const decision = await this.arbiter.tick(snapshot, this.survivalActions, signal);
			this.survivalHolding = decision.rule !== null;
			// 籠りが手放した理由を残す。「前提が消えた」だけでは直せない。
			if (decision.kind === "release" && decision.released === "shelter") {
				// 敵の頭数も一緒に書く。籠りを解いた直後の死は「手放した理由」
				// だけでは追えない。実測 2026-09-22 02:03、夜を越えた直後に
				// 矢で死んだが、夜明けの敵保留が外れたのが至近(半径6)に
				// 数えなかったせいだと、ログからは証明できなかった。
				this.log(
					`[反射] shelter が手放した理由: ${shelterBlocker(snapshot) ?? "(none)"}` +
						`（敵 近傍12=${snapshot.hostilesNear} 至近6=${snapshot.hostilesClose}` +
						`、武器${snapshot.armed ? "あり" : "なし"} 防具${snapshot.armored ? "あり" : "なし"}` +
						`、時刻${snapshot.timeOfDay % 24000}）`,
				);
			}
			// 反射が失敗して手放したなら、待たずに考え直させる。理由は
			// reflexLog に入っていて、次のプロンプトに載る。
			if (decision.kind === "yield") this.requestImmediateThink();
			// LLM が明示的に許した籠りは、LLM から時間を奪ったのではなく LLM の
			// 判断そのもの。計測では別の名前で数え、握りっぱなしの率には入れない。
			const ruleName = decision.rule?.name ?? null;
			const approved =
				ruleName === "shelter" && Date.now() < this.shelterApprovedUntil
					? "shelter(llm)"
					: ruleName;
			this.metrics.noteTick(snapshot, approved);
			this.metrics.reportIfDue(METRICS_REPORT_MS);
			return decision.rule !== null;
		} catch (e) {
			// 反射行動で本来の行動を止めない。
			this.survivalHolding = false;
			if (!signal.aborted) this.log(`反射行動でつまずいた: ${e}`);
			return false;
		}
	}

	/**
	 * 生存判断が見る世界の姿を撮る。
	 *
	 * driver を触るのはここだけ。以降の判断はこのコピーだけを見るので、
	 * サーバーもボットも無しで試せる。
	 */
	private async buildSurvivalSnapshot(): Promise<SurvivalSnapshot> {
		const state = this.driver.getState();
		const pos = state.position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		const distanceTo = (p: Position) => Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z);
		const hostilesNear = this.driver.nearbyEntities(12).filter((e) => isHostileMob(e.name)).length;
		const hostilesClose = this.driver.nearbyEntities(6).filter((e) => isHostileMob(e.name)).length;
		const preyDistances = this.driver
			.nearbyEntities(HUNT_RANGE)
			.filter((e) => PREY_NAMES.has(e.name))
			.map((e) => distanceTo(e.position))
			.sort((a, b) => a - b);
		const items = this.driver.inventory.items();
		const names = items.map((i) => i.name);
		const planks = items
			.filter((i) => i.name.endsWith("_planks"))
			.reduce((sum, i) => sum + i.count, 0);
		const logs = items
			.filter(
				(i) => i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood"),
			)
			.reduce((sum, i) => sum + i.count, 0);
		// 「着ている」だけを armored とする。持っているだけでは数えない。
		//
		// items() に持っている防具を足していたので、革のブーツを1個拾った
		// だけで armored が真になり、equipped() も真になっていた。すると
		// shelterBlocker の「armed and armored, unhurt」が成立し、夜の籠りが
		// 解除される。実質は無防備なので、そのまま歩いて殺される。
		//
		// 実測 2026-09-22 00:47:18(run-180)、stone_sword と leather_boots を
		// 持ち物に入れたまま、時刻 19223(夜)に探索を続けてゾンビに殺された。
		// 拾ったチェストの中身(原木64x4・丸石ほか)を全部落とした。
		// run-165 でも leather_boots を33分持ち歩いて一度も着ず、矢で死んでいる。
		//
		// これで armored は当面ずっと偽になる(着用は status=49 で通らない、
		// bedrock-equipped-gate-is-armor 参照)。つまり夜は必ず籠る。それでよい。
		// 籠って何もしない夜は時間を失うだけだが、無防備で歩く夜は積んだ物を
		// 全部失う。昼は変わらない(shelterBlocker は昼、無傷なら担当しない)。
		//
		// 着ている防具は items() に出てこないので、armor() が唯一の手掛かり。
		const armored = this.driver.inventory.armor().some((i) => i !== null);
		const point = this.getDeathPoint();
		return {
			at: Date.now(),
			ready: state.isReady,
			health: state.health,
			food: state.food,
			foot,
			timeOfDay: state.timeOfDay,
			night: isNightTime(state.timeOfDay),
			hostilesNear,
			hostilesClose,
			preyDistance: preyDistances.length > 0 ? preyDistances[0] : null,
			depthBelowSurface: await this.depthBelowSurface(),
			solidAbove: this.solidAboveCount(foot),
			boxedIn: this.isBoxedIn(foot),
			sheltered: this.isSheltered(foot),
			armed: this.hasWeapon(),
			armored,
			craftableWeapon: planks + logs * 4 >= 6,
			edible: pickFood(names),
			cookable: pickCookable(names),
			lastResortFood: names.includes("rotten_flesh"),
			inventoryCount: items.length,
			recentDeaths: this.countRecentDeaths(),
			deathPoint: point ? { ...point } : null,
			homeDistance: this.spawnBed ? distanceTo(this.spawnBed) : null,
			insideHazard: this.isInHazard(pos),
			sleepRequested: Date.now() - this.othersSleepingAt <= SLEEP_REQUEST_TTL_MS,
			humanRequestFresh: this.hasFreshHumanRequest(),
			// 籠りを保持している間は、LLM の Hide: no を見せない(無視する)。
			shelterDeclined: this.shelterLatch === null && Date.now() < this.shelterDeclinedUntil,
			shelterHeld: this.shelterLatch !== null,
		};
	}

	/**
	 * ルールが使える操作。ここから先は世界を触ってよい。
	 *
	 * ルールは互いを黙らせる手段を持たないので、この一覧に「他をやめさせる」
	 * 類の操作は置かない。
	 */
	private readonly survivalActions: SurvivalActions = {
		log: (message: string) => this.log(message),
		eat: (signal: AbortSignal) => this.eatNow(signal),
		shelter: (signal: AbortSignal) => this.shelterNow(signal),
		escapeBoxedIn: (signal: AbortSignal) => this.escapeIfBoxedIn(signal),
		sleep: (signal: AbortSignal) => this.sleepIfOthersSleeping(signal),
	};

	/** その位置は掘り荒らされた区域の中か。スキル(goto.coords など)からも見る。 */
	public isInHazard(pos: { x: number; z: number }): boolean {
		return hazardAt(this.hazardZones, pos) !== null;
	}

	/** 区域の一覧。探索の向きを決めるのに使う。 */
	public getHazardZones(): readonly HazardZone[] {
		return this.hazardZones;
	}

	/** いまの場所で落ちて死んだ。固まってきたら区域にして控える。 */
	private noteFallDeathHere(): void {
		const pos = this.driver.getState().position;
		const r = noteFallDeath(this.hazardZones, this.fallDeaths, {
			x: Math.round(pos.x),
			z: Math.round(pos.z),
			at: Date.now(),
		});
		this.hazardZones = r.zones;
		this.fallDeaths = r.deaths;
		if (r.added) {
			this.log(
				`[記録] (${r.added.x}, ${r.added.z}) の周り ${r.added.radius} ブロックは穴だらけ(${r.added.reason})。近づかない`,
			);
		}
		this.saveHazards();
	}

	private loadHazards(): void {
		try {
			const file = path.join(process.cwd(), HAZARD_FILE);
			if (!fs.existsSync(file)) return;
			const parsed = parseHazardFile(JSON.parse(fs.readFileSync(file, "utf8")));
			this.hazardZones = parsed.zones;
			this.fallDeaths = parsed.fallDeaths;
			for (const z of this.hazardZones) {
				this.log(`[記録] 危険域 (${z.x}, ${z.z}) 半径${z.radius}: ${z.reason}`);
			}
		} catch {
			// 壊れていたら無かったことにする。
		}
	}

	private saveHazards(): void {
		try {
			const file = path.join(process.cwd(), HAZARD_FILE);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({ zones: this.hazardZones, fallDeaths: this.fallDeaths }, null, 2),
			);
		} catch (e) {
			this.log(`[記録] 危険域を書けなかった: ${e}`);
		}
	}

	/** 食べる。満腹度が実際に増えたときだけ true。 */
	private async eatNow(signal: AbortSignal): Promise<boolean> {
		const before = this.driver.getState().food;
		const ate = await this.driver.eat(signal);
		const after = this.driver.getState().food;
		if (!ate || after <= before) return false;
		this.noteMeal(before, after);
		this.log(`[生存] 食事をとった (満腹度 ${before} → ${after})`);
		return true;
	}

	/** いまの計測をまとめて返す。採点(scenario.ts)が読む。 */
	public metricsSummary() {
		return this.metrics.summary();
	}

	/** 食事を計測に残す。スキル側からも呼ぶ。 */
	public noteMeal(before: number, after: number): void {
		this.metrics.noteMeal(before, after);
	}

	/**
	 * 退く。寝床があれば戻り、無ければその場に潜る。
	 *
	 * 「いつ退くか」はルール表が決めるので、ここは行動だけを持つ。
	 * 既に潜れているなら何もしない。ここで掘ると毎晩1マスずつ沈み、
	 * 実測では Y=66 から Y=39 まで下がっていた。
	 */
	/**
	 * LLM が選んで籠る(survival.hide)。反射の shelter と同じ動作。
	 *
	 * 反射は「夜で丸腰」のような既定でしか籠らない。装備があっても、昼でも、
	 * LLM が「いまは隠れる」と決めたなら、それを実行する経路がここ。
	 */
	public async hideNow(signal: AbortSignal): Promise<{ sheltered: boolean }> {
		await this.shelterNow(signal);
		const pos = this.driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		return { sheltered: this.isSheltered(foot) || this.solidAboveCount(foot) >= BURIED_THICKNESS };
	}

	/** 剣と防具が揃っているか。snapshot の armed && armored と同じ判定。 */
	private isEquippedNow(): boolean {
		// armored の定義は buildSurvivalSnapshot と同じ。持っているだけでは数えない。
		const armored = this.driver.inventory.armor().some((i) => i !== null);
		return this.hasWeapon() && armored;
	}

	private async shelterNow(signal: AbortSignal): Promise<void> {
		// 保持は「籠り始めた」時点で立てる。「籠れた」を待つと、蓋が置けない間に
		// 深さの読みが揺れて手放し、夜の地上を歩き出す(実測 2026-09-21 01:41、
		// 潜り始めて 14 秒後に「地下17で保持なし」で手放し、矢で死亡。実際の
		// 位置は地上 Y=65)。籠り方は shelterNow が続けて試す。
		this.latchNightShelter();
		if (await this.retreatToHome(signal)) {
			this.latchNightShelter();
			return;
		}
		const pos = this.driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		if (this.isSheltered(foot) || this.solidAboveCount(foot) >= BURIED_THICKNESS) {
			this.latchNightShelter();
			// 四方が塞がっているだけで蓋が無いなら、蓋を置く。矢は上から来る。
			// 実測 2026-09-21 02:39〜02:41、四方が塞がった窪みを「籠れた」として
			// 80 秒立ち尽くし、スケルトンに撃たれて死亡。
			const lidCell = { ...foot, y: foot.y + 2 };
			const above = this.driver.world.blockAt(lidCell);
			// 原木でも、自分がそこへ置いた蓋なら蓋として数える(cappedLidAt の説明)。
			const ownLid =
				!!this.cappedLidAt &&
				this.cappedLidAt.x === lidCell.x &&
				this.cappedLidAt.y === lidCell.y &&
				this.cappedLidAt.z === lidCell.z;
			const lidded = !!above && above.name !== "air" && (ownLid || !isTreeBlockName(above.name));
			// 横が開いているなら、削られる前に塞ぐ。
			//
			// isSheltered は蓋が1枚あれば true を返し、四方を一度も見ない
			// (上の「蓋がある。これが本来の潜れた形」の分岐)。そのため
			// 「潜れた」状態のまま横が開きっぱなしになる。矢は横から来るので
			// 蓋では止まらない。実測 2026-09-21、死亡29件のうち8件が夜の籠りを
			// 握ったままで、うち5件が骸骨(4件は death.attack.arrow)。
			// 「籠っているのに削られた」は25回。それに対して横塞ぎは5回しか
			// 走っていない(蓋は46回)。resealRequested、つまり削られた後にしか
			// 呼んでいなかったため。
			//
			// 読めない(null)マスは開いているとみなさない。掘る理由にしないのと
			// 同じ扱い。水と溶岩は sealSides 側が置かずに飛ばすので、ここで
			// 数えると 15 秒ごとに空振りし続ける(水際の籠りは実測で53回ある)。
			const sidesOpen = BOX_DIRECTIONS.some((d) =>
				[foot.y, foot.y + 1].some((y) => {
					const b = this.driver.world.blockAt({ x: foot.x + d.x, y, z: foot.z + d.z });
					if (!b || b.solid) return false;
					return b.name !== "water" && b.name !== "flowing_water" && b.name !== "lava";
				}),
			);
			if ((this.resealRequested || sidesOpen) && Date.now() - this.lastSealAt > 15_000) {
				// 削られた直後。蓋より先に横を塞ぐ(矢は横から来ている)。
				this.resealRequested = false;
				this.lastSealAt = Date.now();
				await this.sealSides(signal);
			}
			if (!lidded && this.capFailures < 3 && Date.now() - this.lastCapAt > 15_000) {
				this.lastCapAt = Date.now();
				await this.capHead(signal);
			} else if (!this.shelteredStayLogged) {
				// 何もしない分岐は一晩に一度だけ書く。実測 2026-09-21 10:50〜10:57、
				// 籠りに入ってから 7 分間ログが無いまま削られ、どの分岐で待っていた
				// のか分からなかった。
				this.shelteredStayLogged = true;
				this.log(
					`[反射] 囲まれているのでここで待つ(頭上 ${above?.name ?? "?"}、四方 ${BOX_DIRECTIONS.map(
						(d) =>
							this.driver.world.blockAt({ x: foot.x + d.x, y: foot.y, z: foot.z + d.z })?.solid
								? "■"
								: "□",
					).join("")}、蓋 ${lidded ? "あり" : `なし(失敗 ${this.capFailures})`})`,
				);
			}
			return;
		}
		// 地下深くでは掘らない。潜るのは足元を掘ることで、地下では「深くなる」
		// だけ。保持中にここへ来るのは、潜った先が洞窟に抜けたとき。動かずに
		// 夜明けを待つ(担当は shelter が持ち続けるので LLM のスキルは動かない)。
		//
		// ただし丸腰の夜は別。穴の中で日没を迎えたときに何もしないと、暗い穴を
		// 歩いて死ぬ(実測 2026-09-21 08:59)。足元を 2 マス掘って蓋をするだけなら
		// 「深くなる」うちに入らない(洞窟・水は burrow 側が断る)。
		{
			const depth = this.lastKnownDepth();
			const bareNight = isNightTime(this.driver.getState().timeOfDay) && !this.isEquippedNow();
			if (depth !== null && depth > DEEP_UNDERGROUND_GAP && !bareNight) return;
		}
		// 掘り進み続けないための歯止め。ただし敵が目の前にいるときは待たない。
		const threatened = this.driver
			.nearbyEntities(HOME_THREAT_RADIUS)
			.some((e) => isHostileMob(e.name));
		if (!threatened && Date.now() - this.lastBurrowAt < BURROW_COOLDOWN_MS) return;
		// 一晩に潜るのは 2 回まで(最大 4 マス)。敵が近いと冷却を飛ばして毎周潜り、
		// 蓋をしては掘り下げる、を繰り返して縦穴になっていた(実測 2026-09-21
		// 04:19〜04:21、3 回で Y=68→65、蓋は毎回置き直し)。それ以上は動かずに待つ。
		// 場所が変わっていれば数え直す。上限は「同じ場所で掘り下げ続けない」ため
		// のもので、逃げて別の場所に立っているなら潜り直してよい(実測 2026-09-21
		// 04:41、上限に当たった時点で頭上は空気、四方は 1 面しか塞がっておらず、
		// 夜の地上に立ったまま動かなかった)。
		if (
			this.lastBurrowPos &&
			Math.hypot(foot.x - this.lastBurrowPos.x, foot.z - this.lastBurrowPos.z) > 1.5
		) {
			this.burrowsThisNight = 0;
		}
		if (this.burrowsThisNight >= 2) {
			if (Date.now() - this.lastShelterDiagAt > 30_000) {
				this.lastShelterDiagAt = Date.now();
				const above = this.driver.world.blockAt({ ...foot, y: foot.y + 2 });
				const sides = BOX_DIRECTIONS.map((d) =>
					this.driver.world.blockAt({ x: foot.x + d.x, y: foot.y, z: foot.z + d.z }),
				);
				this.log(
					`[反射] もう潜らない(今夜 ${this.burrowsThisNight} 回)。頭上 ${above?.name ?? "?"}、足元の四方 ${sides.map((b) => (b?.solid ? "■" : "□")).join("")}`,
				);
			}
			return;
		}
		this.lastBurrowPos = { x: foot.x, y: foot.y, z: foot.z };
		this.lastBurrowAt = Date.now();
		// 実際に潜れた回だけ数える。掘れなかった・落ちなかった回で上限に達すると、
		// 平地に立ったまま「もう潜らない」になる(実測 2026-09-21 05:42)。
		if (await this.burrow(signal)) this.burrowsThisNight++;
	}

	/** 夜に籠れた。夜明けか被弾まで Hide: no を受け付けない。 */
	private latchNightShelter(): void {
		const state = this.driver.getState();
		if (!isNightTime(state.timeOfDay) || this.shelterLatch) return;
		if (Date.now() < this.shelterLatchBlockedUntil) return;
		this.shelterLatch = { health: state.health };
		this.capFailures = 0;
		// 前の籠りで置いた蓋の位置は持ち越さない。場所が違えば当たらないが、
		// 同じ穴へ戻ったときに古い記録で「蓋あり」と読むのを避ける。
		this.cappedLidAt = null;
		this.burrowsThisNight = 0;
		this.homeUnroofedLogged = false;
		this.homeStayLogged = false;
		this.shelteredStayLogged = false;
		this.log("[反射] 夜の籠りに入った。夜明けか被弾まで Hide: no は無視する");
	}

	private dawnHoldLogged = false;
	private homeUnroofedLogged = false;
	private homeStayLogged = false;
	private shelteredStayLogged = false;
	/** 籠っているのに削られた。次の籠り処理で横を塞ぐ。 */
	private resealRequested = false;
	private lastSealAt = 0;

	/** 籠りの保持を解く条件を毎周見る。夜明け・被弾・死亡。 */
	private releaseShelterLatchIfDue(): void {
		if (!this.shelterLatch) return;
		const state = this.driver.getState();
		if (state.health <= 0) {
			this.shelterLatch = null;
			return;
		}
		if (!isNightTime(state.timeOfDay)) {
			// 丸腰で敵が至近なら、明けても少し待つ(rules.ts の shelterBlocker と同じ)。
			const t = ((state.timeOfDay % 24000) + 24000) % 24000;
			const hostileClose = this.driver.nearbyEntities(6).some((e) => isHostileMob(e.name));
			if (t < DAWN_HOSTILE_HOLD_TICK && hostileClose && !this.isEquippedNow()) {
				if (!this.dawnHoldLogged) {
					this.dawnHoldLogged = true;
					this.log("[反射] 夜は明けたが敵が至近。離れるまで籠りを続ける");
				}
				return;
			}
			this.dawnHoldLogged = false;
			this.shelterLatch = null;
			this.log("[反射] 夜が明けた。籠りの保持を解く");
			return;
		}
		if (state.health < this.shelterLatch.health) {
			// 削られた理由を分ける。敵が近くにいないなら落下や溺れで、籠りが
			// 効いていないわけではない(統合版では lastDamageCause は更新されず
			// 常に fall なので使えない)。実測 2026-09-20 20:21、復帰直後に穴へ
			// 落ちた分の被弾で保持を解き、穴底で LLM が夜の移動を始めた。
			const attacked = this.driver
				.nearbyEntities(HOME_THREAT_RADIUS)
				.some((e) => isHostileMob(e.name));
			// 敵に削られても保持は解かない。解いて LLM に返した結果は 3 回とも
			// 1 分以内の死だった(2026-09-20 17:10 夜に作業台を置いて死亡、20:44
			// スケルトン、00:20 ゾンビ)。敵が目の前にいるときに歩き出す判断は、
			// 何を選んでも夜の地上を歩くことになる。逃げる・殴るは毎tickの戦闘
			// 反射(サイドカー)がやる。ここは籠りを続け、潜り直す。
			this.shelterLatch.health = state.health;
			this.log(
				`[反射] 籠っているのに削られた(体力 ${state.health}${attacked ? "、敵が近い" : ""})。保持は続ける`,
			);
			// 穴の中で削られたなら、どこかが開いている。次の籠り処理で横を塞ぐ。
			this.resealRequested = true;
		}
	}

	/** 四方が塞がっていて歩いて出られないか。 */
	private isBoxedIn(foot: Position): boolean {
		const open = (dx: number, dz: number) => {
			const f = this.driver.world.blockAt({ x: foot.x + dx, y: foot.y, z: foot.z + dz });
			const h = this.driver.world.blockAt({ x: foot.x + dx, y: foot.y + 1, z: foot.z + dz });
			if (f === null || h === null) return true;
			// 通れるかは .solid で見る。name === "air" だと、水・海草・シダ・ツタ・
			// 積雪の上に立っているだけで「四方塞がり」に化ける。同じファイルの
			// isSheltered / sealSides / hasRoof / burrow は全部 .solid なので、
			// ここだけ基準が違っていた。
			//
			// 実測 2026-09-21(run-165〜171)、escape_boxed_in が掘った先に
			// seagrass 6 / fern 2 / large_fern 1 / brown_mushroom 2 = 11件の
			// 通れるブロックが混ざっていた。塞がれてなどいなかった。
			return !f.solid && !h.solid;
		};
		return !BOX_DIRECTIONS.some((d) => open(d.x, d.z));
	}

	/** 直近の窓で死んだ回数。 */
	private countRecentDeaths(): number {
		const cutoff = Date.now() - DEATH_STORM_WINDOW_MS;
		this.recentDeaths = this.recentDeaths.filter((t) => t >= cutoff);
		return this.recentDeaths.length;
	}

	/**
	 * 近くに人がいれば、自分から挨拶して手伝いを申し出る。
	 *
	 * 「話しかけられるまで喋らない」だけでは、召使い風の人格なのに
	 * 突っ立って待っているだけに見える。会話中に横から割り込まないよう
	 * 直近の発言からの間隔と、戦闘中でないことを見てから声をかける。
	 * 同じ相手には GREET_COOLDOWN_MS を空けるまで繰り返さない。
	 */
	private maybeGreetNearbyPlayer(): void {
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
		if (this.wasAttackedByPlayerRecently()) return;
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
				this.humanRequestPending = true;
				this.requestImmediateThink();
			}

			if (!result.reply) return;

			await this.speak(result.reply, target);
		} finally {
			this.isReplying = false;
		}
	}

	/**
	 * 自分の列の地表まで、あと何マス上か。分からなければ null。
	 *
	 * 頭上のブロック数(solidAboveCount)では、天井の高い洞窟と地上を区別
	 * できない。BlockView は半径16の立方体しか持たないので、天井がその外に
	 * 出ると「空が見えている」と読めてしまう。列を辿る計算はチャンクを持って
	 * いるサイドカーにやらせる（goto.surface と同じ surfaceScan）。
	 *
	 * 反射は毎周回るのに対しこれはサイドカーへの往復なので、短い間だけ控える。
	 */
	/**
	 * 直近に測った地表までの高さ。測っていない・古いなら null。
	 *
	 * skillIsWorthOffering のような同期の判断から使う。測り直しはしない。
	 * 反射ループが毎周 depthBelowSurface() を呼ぶので、値は数秒以内に保たれる。
	 */
	private lastKnownDepth(): number | null {
		const probe = this.surfaceProbe;
		if (!probe) return null;
		if (Date.now() - probe.at > SURFACE_PROBE_TTL_MS * 4) return null;
		return probe.depth;
	}

	private async depthBelowSurface(): Promise<number | null> {
		const now = Date.now();
		if (this.surfaceProbe && now - this.surfaceProbe.at < SURFACE_PROBE_TTL_MS) {
			return this.surfaceProbe.depth;
		}
		const state = this.driver.getState();
		if (!state.isReady) return null;
		const myY = Math.floor(state.position.y);
		let depth: number | null = null;
		try {
			const columns = await this.driver.world.surfaceScan(SURFACE_PROBE_RADIUS);
			// 自分の列が返るとは限らない。読めていない列は返らないので、
			// 見つからなければ一番近い列で代用する。
			// 自分の列だけで見ない。木の下に立つと自分の列の「地表」は葉の上
			// (10マス上)になり、地上にいるのに「地下11」と数えて籠り反射が
			// 「地下深くでは潜らない」で手を引く。実測 2026-09-20 19:41、日没に
			// 木の下で反射が外れ、直後にクリーパーで死亡。半径2の列のうち葉や
			// 幹でない列の最小を取れば、木の下でも地面の高さが出る。縦穴の中
			// なら周りの列も全部高いので、深さはそのまま残る。
			//
			// ただし最小を無条件に取ると、クレーターの中で隣の縦穴の底が「地表」に
			// なり、地下33で「地上」と数える(実測 20:24、水没した縦穴の中で籠り反射が
			// 動いて溺死)。自分の列が葉・幹でなければ自分の列を信じ、葉・幹のとき
			// だけ周りの地面の列の最小を使う。
			const isTree = isTreeBlockName;
			const myX = Math.floor(state.position.x);
			const myZ = Math.floor(state.position.z);
			const mine = columns.find((c) => c.x === myX && c.z === myZ);
			if (mine && !isTree(mine.name)) {
				depth = mine.y - myY;
			} else {
				const ground = columns.filter((c) => !isTree(c.name));
				const pool = ground.length > 0 ? ground : columns;
				if (pool.length > 0) {
					depth = Math.max(0, Math.min(...pool.map((c) => c.y - myY)));
				}
			}
		} catch {
			// 数えられないなら「分からない」を返す。地上と決めつけない。
		}
		this.surfaceProbe = { at: now, depth };
		return depth;
	}

	/**
	 * 頭上に積まっている固いブロックの数。
	 *
	 * 「埋まっているか」と「もう隠れているか」で同じ数字を見る。屋根が
	 * 厚いなら、そこは既に地下であり、同時に mob から隠れてもいる。
	 */
	private solidAboveCount(foot: Position): number {
		let solidAbove = 0;
		for (let y = foot.y + 2; y <= foot.y + 2 + BURIED_SCAN_HEIGHT; y++) {
			const above = this.driver.world.blockAt({ x: foot.x, y, z: foot.z });
			if (above === null) break;
			// 葉や幹は「埋まっている」に数えない。木の下は地上。
			if (above.name !== "air" && !isTreeBlockName(above.name)) solidAbove++;
		}
		return solidAbove;
	}

	/**
	 * 誰かがベッドに入っていたら、自分も寝る。
	 *
	 * 統合版は全員が寝ないと夜を飛ばせない。起きているのがボット1体でも
	 * 他の人は朝を迎えられず、これは会話の割り込みより実害が大きい。
	 * 自分のベッドは持っていないので、近くにある人のベッドを借りる
	 * （バニラでは他人のベッドでも寝られる。リスポーン地点が移るだけ）。
	 *
	 * 戻り値が true なら、この周の他の反射は行わない。
	 */
	private async sleepIfOthersSleeping(signal: AbortSignal): Promise<boolean> {
		if (Date.now() - this.othersSleepingAt > SLEEP_REQUEST_TTL_MS) return false;

		// もう入っている。ベッドをもう一度叩くと自分が起きてしまうので、
		// 寝ている扱いのまま何もしない。就寝の通知は自分がベッドに入った
		// ときにも飛んでくるため、この歯止めが無いと寝る・起きるを繰り返す。
		if (Date.now() - this.lastBedActivatedAt < SLEEP_REQUEST_TTL_MS) return true;

		const state = this.driver.getState();
		if (!state.isReady || state.health <= 0) return false;
		// ネザーとエンドでベッドを使うと爆発する。寝る話ではない。
		if (state.dimension && !state.dimension.includes("overworld")) return false;

		// BlockView(半径16)ではなくサイドカーのチャンクを引く。同期版は
		// maxDistance を黙って16に切り詰めるので、BED_SEARCH_RADIUS=48 と
		// 書いてあっても16しか見ていなかった。
		const beds = await this.driver.world.findBlocksFar(
			BED_NAMES,
			BED_SEARCH_RADIUS,
			BED_CANDIDATES,
		);
		const bed = this.pickReachableBed(beds);
		if (!bed) {
			// 無いものは探し直しても無い。毎周探して報告し続けないよう、
			// 知らせを消してこの夜は諦める。
			this.othersSleepingAt = 0;
			this.log("[反射] 誰か寝ているが、届く範囲にベッドが無い。席を譲って抜ける");
			// 寝られないまま居座ると、他の全員が寝ているのに夜が明けない
			// ままになる。抜ける判断は呼び出し側(接続の管理者)に委ねる。
			this.onNoBedForSleep?.();
			return false;
		}

		this.log("[反射] 誰かが寝ている。ベッドへ向かう");
		try {
			await this.driver.goto(signal, { kind: "getToBlock", position: bed.position });
			await this.holdToolForInteraction();
			const r = await this.driver.useBed(bed.position);
			this.lastBedActivatedAt = Date.now();
			// 寝た時点でリスポーン地点もそこへ移る。登録し直す反射
			// (registerSpawnAtBed)が同じベッドへもう一度歩かないよう控える。
			// ただしサーバーの応答が無い(叩けていない)ときは覚えない。
			if (r !== "none") {
				this.spawnBed = { ...bed.position };
				this.lastSpawnBedAt = Date.now();
				this.saveHome();
			} else {
				this.log("[反射] ベッドを叩いたが応答が無い");
			}
		} catch (e) {
			if (!signal.aborted) this.log(`ベッドに入れなかった: ${e}`);
			// 一度失敗したら諦める。夜が明けるまで往復し続ける方が邪魔になる。
			this.othersSleepingAt = 0;
			return false;
		}
		return true;
	}

	/**
	 * 昼のうちにベッドを叩いて、リスポーン地点を自分の近くへ移す。
	 *
	 * 統合版はベッドを叩いた時点でリスポーン地点が移る。夜である必要は
	 * ないし、寝られなくてもよい(「今は寝られません」と出ても地点は移る)。
	 *
	 * これをやっていなかったので、死ぬたびにワールドスポーンへ戻されていた。
	 * 死亡地点の座標は7日間ずっと X:-22〜15 / Z:52〜84 の約40ブロック四方に
	 * 収まっている。集めた物は死んだ場所に落ちたままなので、戻されるたびに
	 * 拠点でも死亡地点でもないところから歩き直すことになる。
	 *
	 * 自分のベッドは持っていないので、人のベッドを借りる。バニラでは他人の
	 * ベッドでもリスポーン地点は移る。壊したり動かしたりはしない。
	 */
	private async registerSpawnAtBed(signal: AbortSignal): Promise<void> {
		if (Date.now() - this.lastSpawnBedAt < SPAWN_BED_COOLDOWN_MS) return;

		const state = this.driver.getState();
		if (!state.isReady || state.health <= 0) return;
		// ネザーとエンドでベッドに触ると爆発する。
		if (state.dimension && !state.dimension.includes("overworld")) return;
		// 夜のベッド探しは、暗い中を32ブロック歩くのと同じ。昼にやる。
		// 夜に寝る話は sleepIfOthersSleeping が別に持っている。
		if (isNightTime(state.timeOfDay)) return;
		// 追われている最中に寄り道しない。
		if (this.driver.nearbyEntities(16).some((e) => isHostileMob(e.name))) return;
		if (state.health <= SHELTER_HEALTH) return;

		// 探す前に間隔を消費する。見つからなかったときにここを通さないと、
		// ベッドの無い場所では反射のたびに半径32の全走査を投げることになる。
		// 見つかった場合も、届かなかった場合も、同じだけ間を置けばよい。
		this.lastSpawnBedAt = Date.now();

		const beds = await this.driver.world.findBlocksFar(
			BED_NAMES,
			BED_SEARCH_RADIUS,
			BED_CANDIDATES,
		);
		const bed = this.pickReachableBed(beds);
		if (!bed) return;

		// 直前に登録したのと同じベッドなら、行くだけ無駄。
		if (
			this.spawnBed &&
			Math.hypot(
				this.spawnBed.x - bed.position.x,
				this.spawnBed.y - bed.position.y,
				this.spawnBed.z - bed.position.z,
			) < 2
		) {
			return;
		}

		this.log(
			`[反射] リスポーン地点を登録しに行く (${bed.position.x}, ${bed.position.y}, ${bed.position.z})`,
		);
		try {
			await this.driver.goto(signal, { kind: "getToBlock", position: bed.position });
			if (!(await this.activateBedWithRetry(signal, bed.position))) {
				// 登録できていないのに覚えると、死んだ後の判断が全部ずれる。
				// 少し置いてもう一度試す。
				this.lastSpawnBedAt = Date.now() - SPAWN_BED_COOLDOWN_MS + SPAWN_BED_RETRY_MS;
				return;
			}
			this.spawnBed = { ...bed.position };
			this.saveHome();
			this.log("[反射] リスポーン地点を登録した(サーバー応答あり)");
		} catch (e) {
			if (!signal.aborted) {
				this.log(`リスポーン地点を登録できなかった: ${e}`);
				// そのベッドは「近いが入れない」。次は別のベッドを見る。
				this.noteUnreachableBed(bed.position);
				// 失敗したぶんは待たない。次の候補をすぐ試す。
				this.lastSpawnBedAt = Date.now() - SPAWN_BED_COOLDOWN_MS + SPAWN_BED_RETRY_MS;
			}
		}
	}

	/**
	 * 見かけた人工物を控える。
	 *
	 * 地上に出ても行き先が無いと、その場でランダムに歩き回るだけになる。
	 * 実測では7日間、拠点に一度も到達せず Known Bases は空のままだった。
	 * 視界から外れた建物を覚えておけば、そちらを目指せる。
	 *
	 * BlockView(半径16)では建物に触れるまで気付けないので、サイドカーが
	 * 持っているチャンク(半径32)を引く。全走査に振れうるので間隔を空ける。
	 */
	private async noteLandmarksNearby(): Promise<void> {
		if (Date.now() - this.lastLandmarkScanAt < LANDMARK_SCAN_INTERVAL_MS) return;
		const state = this.driver.getState();
		if (!state.isReady || state.health <= 0) return;
		this.lastLandmarkScanAt = Date.now();

		const found = await this.driver.world.findBlocksFar(MANMADE_BLOCKS, LANDMARK_SEARCH_RADIUS, 8);
		if (found.length === 0) return;

		// 埋まっている人工物は自分の残骸。地表より深くにある作業台や板を
		// 目印にすると、穴へ戻る。列の地表が読めた分だけ判定する。
		// 読めない(遠い)列は「分からない」なので、目印のまま残す。
		let surface = new Map<string, number>();
		try {
			const cols = await this.driver.world.surfaceScan(LANDMARK_SURFACE_RADIUS);
			surface = new Map(cols.map((c) => [`${c.x},${c.z}`, c.y]));
		} catch {
			// 読めなければ深さの判定は飛ばす。
		}
		const buriedAt = (p: Position): boolean => {
			const top = surface.get(`${Math.floor(p.x)},${Math.floor(p.z)}`);
			if (top === undefined) return false;
			return top - p.y > LANDMARK_BURIED_DEPTH;
		};

		const now = Date.now();
		for (const b of found) {
			// 同じ建物の中の別のブロックを何個も覚えない。粗い格子でまとめる。
			const key = (p: Position) =>
				`${Math.floor(p.x / LANDMARK_GRID)},${Math.floor(p.y / LANDMARK_GRID)},${Math.floor(p.z / LANDMARK_GRID)}`;
			const k = key(b.position);
			const buried = buriedAt(b.position) || this.isInHazard(b.position);
			const existing = this.knownLandmarks.find((l) => key(l.position) === k);
			if (existing) {
				existing.at = now;
				// 一度「埋まっている」と分かったら、読めない周で戻さない。
				existing.buried = existing.buried || buried;
				continue;
			}
			this.knownLandmarks.push({ position: { ...b.position }, name: b.name, at: now, buried });
			this.log(
				`[記憶] 人工物を見つけた: ${b.name} (${b.position.x}, ${b.position.y}, ${b.position.z})${buried ? "（埋まっている・目印にしない）" : ""}`,
			);
		}

		// 近い順に残す。遠いものを抱え続けても、そこまで歩けない。
		const here = state.position;
		this.knownLandmarks.sort(
			(a, b) =>
				Math.hypot(a.position.x - here.x, a.position.z - here.z) -
				Math.hypot(b.position.x - here.x, b.position.z - here.z),
		);
		this.knownLandmarks = this.knownLandmarks.slice(0, LANDMARK_MEMORY_LIMIT);
	}

	/**
	 * 覚えている人工物を近い順に返す。
	 *
	 * スキル(goto.landmark)と思考プロンプトの両方から読む。探索の向きを
	 * 決めるのにも使うので、公開しておく。
	 */
	public getKnownLandmarks(): { position: Position; name: string }[] {
		const here = this.driver.getState().position;
		return (
			this.knownLandmarks
				.slice()
				// 二度殺された区域にある建物は行き先にしない。
				.filter((l) => !this.isNearRecentDeath(l.position))
				// 埋まっている残骸と、掘り荒らされた区域の中の物も行き先にしない。
				.filter((l) => !l.buried && !this.isInHazard(l.position))
				.sort(
					(a, b) =>
						Math.hypot(a.position.x - here.x, a.position.z - here.z) -
						Math.hypot(b.position.x - here.x, b.position.z - here.z),
				)
				.map((l) => ({ position: l.position, name: l.name }))
		);
	}

	/**
	 * 自分で置いたベッドを寝床として控える(building.bed から)。
	 *
	 * registerSpawnAtBed は「見かけた人のベッド」を借りる経路で、20分の間隔が
	 * ある。自分で置いた直後はその間隔を待たずに、ここが帰る先になる。
	 */
	public noteOwnBed(pos: Position): void {
		this.spawnBed = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		this.lastSpawnBedAt = Date.now();
		this.homeUnreachableUntil = 0;
		this.unreachableBeds.delete(this.bedKey(this.spawnBed));
		this.saveHome();
		this.log(
			`[記録] 自分のベッドを寝床にした (${this.spawnBed.x}, ${this.spawnBed.y}, ${this.spawnBed.z})`,
		);
	}

	/** 寝床の位置をディスクへ書く。再起動しても帰る場所を忘れないため。 */
	private saveHome(): void {
		if (!this.spawnBed) return;
		try {
			const file = path.join(process.cwd(), HOME_FILE);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(this.spawnBed));
		} catch {
			// 書けなくても行動は続く。次に見つけたベッドで登録し直すだけ。
		}
	}

	/** 起動時に寝床を読み戻す。 */
	private loadHome(): void {
		// .env の指定が最優先。人が「ここが安全だ」と言っている場所を、
		// こちらの都合で上書きしない。
		const configured = this.configuredHome();
		if (configured) {
			this.spawnBed = configured;
			this.log(
				"[記録] 寝床は指定された (" +
					configured.x +
					", " +
					configured.y +
					", " +
					configured.z +
					")",
			);
			return;
		}
		try {
			const file = path.join(process.cwd(), HOME_FILE);
			if (!fs.existsSync(file)) return;
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof raw?.x !== "number" || typeof raw?.y !== "number" || typeof raw?.z !== "number") {
				return;
			}
			// 危険域の中の寝床は寝床ではない。実測 2026-09-20、控えてあった
			// (6, 73, 66) はクレーターの真上で、夜ごとにそこへ戻って落ち、
			// 死ぬたびにそこへ生まれ直して穴底から始めていた(死亡30回中14回)。
			if (hazardAt(this.hazardZones, raw)) {
				this.log(
					`[記録] 控えてあった寝床 (${raw.x}, ${raw.y}, ${raw.z}) は危険域の中なので捨てる。ベッドを外に置き直す必要がある`,
				);
				return;
			}
			this.spawnBed = { x: raw.x, y: raw.y, z: raw.z };
			this.log(`[記録] 寝床は (${raw.x}, ${raw.y}, ${raw.z})`);
		} catch {
			// 壊れていたら無かったことにする。
		}
	}

	/**
	 * 死んだ場所を控える。近い場所で死んだら同じ区域として数える。
	 */
	private noteDeathPlace(pos: Position): void {
		const now = Date.now();
		this.deathZones = this.deathZones.filter((z) => now - z.at < DEATH_ZONE_TTL_MS);
		const near = this.deathZones.find(
			(z) => Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y, z.pos.z - pos.z) <= DEATH_ZONE_RADIUS,
		);
		if (near) {
			near.count++;
			near.at = now;
			if (near.count === DEATH_ZONE_STRIKES) {
				this.log(
					`[記録] (${near.pos.x.toFixed(0)}, ${near.pos.y.toFixed(0)}, ${near.pos.z.toFixed(0)}) 付近で ${near.count} 回死んだ。しばらく近づかない`,
				);
			}
			return;
		}
		this.deathZones.push({ pos: { ...pos }, at: now, count: 1 });
		if (this.deathZones.length > DEATH_ZONE_LIMIT) this.deathZones.shift();
	}

	/**
	 * そこは短い間に二度以上死んだ場所の近くか。
	 *
	 * 行き先を選ぶ側(人工物・落とし物)から見る。近づかなければ、そこにいる
	 * 相手が何であっても巻き込まれない。
	 */
	public isNearRecentDeath(pos: Position): boolean {
		const now = Date.now();
		return this.deathZones.some(
			(z) =>
				z.count >= DEATH_ZONE_STRIKES &&
				now - z.at < DEATH_ZONE_TTL_MS &&
				Math.hypot(z.pos.x - pos.x, z.pos.y - pos.y, z.pos.z - pos.z) <= DEATH_ZONE_RADIUS,
		);
	}

	/** 死んだ時刻を控える。死にすぎていないかを見るために持つ。 */
	private noteDeath(): void {
		this.recentDeaths.push(Date.now());
		this.metrics.noteDeath();
		{
			const depth = this.lastKnownDepth();
			this.deathFacts.push({
				night: isNightTime(this.driver.getState().timeOfDay),
				surface: depth === null || depth <= DEEP_UNDERGROUND_GAP,
			});
			if (this.deathFacts.length > 20) this.deathFacts.splice(0, this.deathFacts.length - 20);
		}
		// 死んだら状況は作り直される。担当も持ち越さない。
		this.arbiter.reset();
		// 構えも既定に戻す。「殴り合え」と決めた前提(武器・体力)は死んで消えた。
		if (this.stance !== "auto") {
			this.stance = "auto";
			this.driver.setStance("auto").catch(() => {});
		}
		// 抜ける判断はここでする。潜る・寝床へ戻るといった手が全部
		// 通らない場所で死に続けることがあり、その間ずっと死亡ログを
		// 撒き続けることになる。
		const cutoff = Date.now() - DEATH_STORM_WINDOW_MS;
		const recent = this.recentDeaths.filter((t) => t >= cutoff).length;
		if (recent >= DEATH_STORM_LEAVE_LIMIT) {
			this.log(`[判断] ${DEATH_STORM_WINDOW_MS / 60_000}分で${recent}回死んだ。一度抜ける`);
			this.onDeathStorm?.(recent);
		}
		if (this.recentDeaths.length > 32) this.recentDeaths.splice(0, this.recentDeaths.length - 32);
	}

	/**
	 * 短い間に死に続けているか。
	 *
	 * 死ぬたびにサーバーの死亡ログが全員のチャット欄に流れる。実測では
	 * 1日で141行、他の人の画面はほぼこれで埋まっていた。装備が揃っていても、
	 * 死に続けているなら夜歩きをやめさせる根拠になる。
	 */
	private isDyingRepeatedly(): boolean {
		return this.countRecentDeaths() >= DEATH_STORM_LIMIT;
	}

	/** 人から頼まれた直後か。自分から申し出たぶんは数えない。 */
	private hasFreshHumanRequest(): boolean {
		const request = this.pendingRequest;
		if (!request || request.selfInitiated) return false;
		return Date.now() - request.at <= SHELTER_YIELD_MS;
	}

	/**
	 * 寝床へ戻る。戻れた(または既にいる)なら true。
	 *
	 * 帰る場所は registerSpawnAtBed が登録したベッド。人が用意した寝床は
	 * たいてい湧きつぶした屋内にあるので、そこにいる限り夜をやり過ごせる。
	 *
	 * 遠すぎるときは戻らない。夜道を100ブロック歩くのは、その場で潜るより
	 * 危ない。戻れなかったときも false を返し、呼び出し側の「潜る」へ譲る。
	 */
	private async retreatToHome(signal: AbortSignal): Promise<boolean> {
		// 登録できていなくても、見かけたベッドは帰る先になる。
		// リスポーン地点の登録は届かずに失敗することがあり(実測 6.1 ブロック
		// 手前で「遠すぎて届きません」)、そのあと 20分 は登録し直さない。
		// 「登録できていない」ことと「帰る場所を知らない」ことは別。
		const home = this.configuredHome() ?? this.spawnBed ?? this.nearestKnownBed();
		if (!home) return false;
		// 危険域の中へは帰らない。夜道の先が穴だらけなら、帰る途中で落ちる。
		// 実測 2026-09-20 03:15/04:07/05:15、「寝床へ戻る」の直後に穴底で死亡。
		if (this.isInHazard(home)) {
			if (this.spawnBed && this.bedKey(this.spawnBed) === this.bedKey(home)) {
				this.log("[反射] 寝床が危険域の中にある。帰る先から外す");
				this.spawnBed = null;
			}
			return false;
		}
		// 直前に着けなかったなら、しばらくは潜る方に任せる。
		if (Date.now() < this.homeUnreachableUntil) return false;

		// 追われている最中は歩かない。
		//
		// 丸腰で背中を向けて歩くのは、その場で隠れるより悪い。しかも
		// 「着いていない間は敵を見ない」ままだと、寝床に敵がいて離れ、
		// 離れたから戻る、を敵の前で繰り返すことになる。実測
		// 2026-09-13 15:42、寝床に入る→敵がいる→戻る、の往復の途中で
		// ゾンビに殺された。敵が近いなら、その場で隠れる方へ譲る。
		if (this.driver.nearbyEntities(HOME_THREAT_RADIUS).some((e) => isHostileMob(e.name))) {
			return false;
		}

		const pos = this.driver.getState().position;
		const dist = Math.hypot(home.x - pos.x, home.y - pos.y, home.z - pos.z);
		if (dist > HOME_RETREAT_RADIUS) return false;

		if (dist <= HOME_ARRIVE_RADIUS) {
			this.homeUnreachableUntil = 0;

			this.inspectHomeSurroundings(home);

			// 寝床に着いた＝安全、ではない。
			//
			// 「寝床の4マス以内」は「湧きつぶした部屋の中」とは限らない。
			// 壁の外側で止まっていることもあるし、部屋の中まで mob が
			// 入ってきていることもある。実測 2026-09-13 15:38:06 に寝床へ
			// 入り、15:39:24 にゾンビに殺された。サーバーも
			// tile.bed.notSafe(近くに敵がいる)を返していた。
			// 敵がいるなら、突っ立っていないで隠れ直す（呼び出し側の
			// 「潜る」へ譲る）。
			if (this.driver.nearbyEntities(HOME_THREAT_RADIUS).some((e) => isHostileMob(e.name))) {
				this.log("[反射] 寝床に敵がいる。ここには留まらない");
				return false;
			}

			// 寝床の周りに屋根が無いなら「屋内」ではない。人の家の外や、
			// 屋外に置かれたベッドの脇で 7 分立ち尽くして削られた(実測
			// 2026-09-21 10:50〜10:57、蓋も潜りも無し)。潜る判断に譲る。
			const feet = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
			if (this.solidAboveCount(feet) === 0 && !this.isSheltered(feet)) {
				if (!this.homeUnroofedLogged) {
					this.homeUnroofedLogged = true;
					this.log("[反射] 寝床の上に屋根が無い。ここでは夜を越せないので潜る");
				}
				return false;
			}
			if (!this.homeStayLogged) {
				this.homeStayLogged = true;
				this.log("[反射] 寝床に着いた。屋根の下でここから動かない");
			}
			// もう寝床にいる。ここから動かない。寝られるなら寝る。
			await this.sleepAtHome(home);
			return true;
		}

		// 向かっている途中でも「隠れている扱い」を続ける。ここで false を
		// 返すと、間隔待ちのあいだだけスキルが動いて、寝床から離れる方向へ
		// 歩き直すことになる。
		if (Date.now() - this.lastHomeRetreatAt < HOME_RETREAT_COOLDOWN_MS) return true;
		this.lastHomeRetreatAt = Date.now();

		this.log(`[反射] 寝床へ戻る (${home.x}, ${home.y}, ${home.z}) — ${Math.round(dist)}ブロック`);
		try {
			await this.driver.goto(signal, { kind: "near", position: home, distance: 2 });
		} catch (e) {
			if (!signal.aborted) this.log(`寝床へ戻れなかった: ${e}`);
			// 戻れないなら、その場で潜る判断に任せる。
			this.homeUnreachableUntil = Date.now() + HOME_UNREACHABLE_MS;
			return false;
		}

		// 本当に着いたかを測って確かめる。goto は届かないまま成功を返す
		// ことがあるので、返り値は根拠にならない。着いていないのに
		// 「寝床にいる」ことにすると、反射がスキルを止めたまま夜通し
		// 外に突っ立つ。潜る判断へ譲った方がまだ安全。
		const after = this.driver.getState().position;
		if (Math.hypot(after.x - home.x, after.y - home.y, after.z - home.z) > HOME_ARRIVE_RADIUS) {
			this.log("[反射] 寝床へ着けなかった。潜る方にする");
			this.homeUnreachableUntil = Date.now() + HOME_UNREACHABLE_MS;
			this.noteUnreachableBed(home);
			// 登録済みの寝床に入れないなら、控えも捨てる。入れない場所を
			// 帰る先として持ち続けると、毎晩そこへ向かって失敗する。
			if (this.spawnBed && this.bedKey(this.spawnBed) === this.bedKey(home)) this.spawnBed = null;
			return false;
		}

		await this.sleepAtHome(home);
		return true;
	}

	/**
	 * ベッドを叩く。届かなければ一歩寄って、もう一度だけ試す。
	 *
	 * getToBlock で向かっても手前で止まることがある。実測 02:02:54、
	 * 6.1 ブロック手前で「遠すぎて届きません」と返っていた。ここで諦めると
	 * 次の登録まで 20分 空くので、その場で寄り直す。
	 */
	/**
	 * ブロックを「使う」前に、置けない物(道具・武器)を手に持つ。
	 *
	 * サイドカーの activate は設置と同じ ClickBlock で、手に土や丸石を持ったまま
	 * ベッドを叩くとサーバーは設置を優先する(sidecar の注記どおり)。実測
	 * 2026-09-21 06:55、土を持ったままベッドを叩いて「登録した」と記録したが、
	 * サーバーからの「Respawn point set」は来ず、死後は初期リスに戻された。
	 */
	public async holdToolForInteraction(): Promise<void> {
		const items = this.driver.inventory.items();
		const tool = items.find((i) => /_(sword|pickaxe|axe|shovel|hoe)$|^bow$|^stick$/.test(i.name));
		if (!tool) return;
		try {
			await this.driver.equip(tool.name, "hand");
		} catch {
			// 持ち替えられなくても叩いてみる。
		}
	}

	/**
	 * ベッドを叩いて復帰地点を移す。サーバーの応答が無ければ一度だけ叩き直す。
	 * 戻り値はサーバーが認めたか(respawnSet か、既に登録済みの応答)。
	 */
	private async activateBedWithRetry(signal: AbortSignal, at: Position): Promise<boolean> {
		await this.holdToolForInteraction();
		let result: "set" | "ack" | "none";
		try {
			result = await this.driver.useBed(at);
		} catch (e) {
			if (signal.aborted) throw e;
			this.log(`[反射] ベッドに届かない。寄り直す: ${e}`);
			await this.driver.goto(signal, { kind: "near", position: at, distance: 1 });
			await this.holdToolForInteraction();
			result = await this.driver.useBed(at);
		}
		if (result === "none") {
			// 叩けていない。持ち替えが遅れた等。一度だけ叩き直す。
			await this.holdToolForInteraction();
			result = await this.driver.useBed(at);
		}
		if (result === "none") {
			this.log("[反射] ベッドを叩いたがサーバーから応答が無い(登録されていない)");
			return false;
		}
		return true;
	}

	/**
	 * 寝床の周りの様子を一度だけ書き出す。
	 *
	 * 「湧きつぶした安全な場所」に置かれた寝床のはずが、そこで夜に
	 * 何度も殺されている(実測 2026-09-13、死亡地点が (287,65,165)
	 * (281,68,163) (277,66,160) と寝床の数ブロック以内に固まっている)。
	 * 部屋に入れていないのか、部屋に穴があるのかは、こちらからは見えない。
	 * 囲いと扉の有無を控えておけば、人が直せる。
	 */
	private inspectHomeSurroundings(home: Position): void {
		if (this.inspectedHome) return;
		this.inspectedHome = true;

		const bed = { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) };
		let wall = 0;
		let gap = 0;
		let unknown = 0;
		// 寝床を囲む 5x5 の壁(足と頭の高さ)を数える。
		for (const dy of [0, 1]) {
			for (let dx = -2; dx <= 2; dx++) {
				for (let dz = -2; dz <= 2; dz++) {
					if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
					const b = this.driver.world.blockAt({ x: bed.x + dx, y: bed.y + dy, z: bed.z + dz });
					if (b === null) unknown++;
					else if (b.solid) wall++;
					else gap++;
				}
			}
		}
		const roof = this.driver.world.blockAt({ x: bed.x, y: bed.y + 2, z: bed.z });
		const doors: string[] = [];
		for (let dx = -5; dx <= 5; dx++) {
			for (let dy = -1; dy <= 2; dy++) {
				for (let dz = -5; dz <= 5; dz++) {
					const b = this.driver.world.blockAt({ x: bed.x + dx, y: bed.y + dy, z: bed.z + dz });
					if (!b) continue;
					if (b.name.includes("door") || b.name.includes("fence_gate")) {
						doors.push(b.name + "(" + b.position.x + "," + b.position.y + "," + b.position.z + ")");
					}
				}
			}
		}
		this.log(
			"[診断] 寝床(" +
				bed.x +
				"," +
				bed.y +
				"," +
				bed.z +
				") の囲い: 壁" +
				wall +
				" 隙間" +
				gap +
				" 未取得" +
				unknown +
				" / 屋根 " +
				(roof ? roof.name : "不明") +
				" / 扉 " +
				(doors.length > 0 ? doors.slice(0, 4).join(" ") : "無し"),
		);
	}

	/**
	 * .env で指定された寝床。指定があればこちらを正とする。
	 *
	 * 自動で選ぶと「一番近いベッド」になる。実測 2026-09-13、そうして
	 * 選ばれた (286,66,166) は屋根が無く(囲い 32 マス中 12)、野ざらしの
	 * ベッドだった。そこへ毎晩帰っては殺されていた。人が湧きつぶした
	 * 部屋がどれかは、人にしか分からない。
	 *
	 * 書き方: HOME_POSITION=x,y,z
	 */
	private configuredHome(): Position | null {
		const raw = process.env.HOME_POSITION;
		if (!raw) return null;
		const parts = raw.split(",").map((v) => Number(v.trim()));
		if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
		return { x: parts[0], y: parts[1], z: parts[2] };
	}

	/** そのベッドに屋根があるか。読めない位置なら false（根拠にしない）。 */
	private hasRoof(p: Position): boolean {
		const above = this.driver.world.blockAt({
			x: Math.floor(p.x),
			y: Math.floor(p.y) + 2,
			z: Math.floor(p.z),
		});
		return !!above && above.solid;
	}

	/** 覚えているベッドのうち、一番近くて、避けていないもの。 */
	private nearestKnownBed(): Position | null {
		const bed = this.getKnownLandmarks().find(
			(l) =>
				BED_NAMES.includes(l.name) &&
				!this.isBedAvoided(l.position) &&
				!this.isInHazard(l.position),
		);
		return bed ? bed.position : null;
	}

	/**
	 * 候補のうち、避けていない一番近いベッド。屋根のあるものを優先する。
	 *
	 * 野ざらしのベッドを寝床にすると、夜に帰るたびにそこで殺される。
	 * 屋根が読めない距離のベッドは判断材料にならないので、その場合は
	 * 従来どおり近い順。
	 */
	private pickReachableBed<T extends { position: Position }>(beds: T[]): T | undefined {
		// 危険域の中のベッドは候補にしない。登録すれば死ぬたびに穴へ戻る。
		const usable = beds.filter(
			(b) => !this.isBedAvoided(b.position) && !this.isInHazard(b.position),
		);
		return usable.find((b) => this.hasRoof(b.position)) ?? usable[0];
	}

	private bedKey(p: Position): string {
		return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
	}

	private isBedAvoided(p: Position): boolean {
		const until = this.unreachableBeds.get(this.bedKey(p));
		if (until === undefined) return false;
		if (Date.now() >= until) {
			this.unreachableBeds.delete(this.bedKey(p));
			return false;
		}
		return true;
	}

	/** 届かなかったベッドを覚える。しばらく別のベッドを見る。 */
	private noteUnreachableBed(p: Position): void {
		this.unreachableBeds.set(this.bedKey(p), Date.now() + BED_BLACKLIST_MS);
		this.log(`[反射] (${p.x}, ${p.y}, ${p.z}) のベッドには入れない。しばらく別を見る`);
	}

	/**
	 * 寝床にいる間、夜ならベッドに入る。
	 *
	 * 統合版は全員が寝ないと夜を飛ばせないので、これで朝になるとは限らない。
	 * それでも、入っていれば mob に狙われにくく、他の人が寝たときに夜を
	 * 飛ばせる。入り直すと自分が起きてしまうので、間隔を置く。
	 */
	private async sleepAtHome(home: Position): Promise<void> {
		const state = this.driver.getState();
		if (!isNightTime(state.timeOfDay)) return;
		if (Date.now() - this.lastBedActivatedAt < SLEEP_REQUEST_TTL_MS) return;
		// 登録したときのベッドが、今もそこにあるか。人が片付けたベッドを
		// 叩いても何も起きない。
		const block = this.driver.world.blockAt(home);
		if (!block || !BED_NAMES.includes(block.name)) return;

		try {
			await this.holdToolForInteraction();
			const r = await this.driver.useBed(home);
			this.lastBedActivatedAt = Date.now();
			// 統合版はベッドを叩いた時点でリスポーン地点が移る。サーバーの
			// 応答があったときだけ、帰る先として覚え直す。
			if (r !== "none") {
				this.spawnBed = { ...home };
				this.saveHome();
			}
			this.log(`[反射] 寝床に入る(応答: ${r})`);
		} catch {
			// 入れなくても、屋内にいるだけで夜はしのげる。
		}
	}

	/**
	 * もう身を隠せているか。
	 *
	 * 頭上の蓋だけを見ると足りない。蓋を置けずに1マス掘っただけで終わった場合、
	 * 落ちたぶん基準がずれて、頭上に見えるのは「さっきまで頭があった空気」に
	 * なる。それを「まだ地上にいる」と読むので、反射のたびに掘り直して
	 * 夜通し真下へ掘り進んでしまう。穴に入れているかどうかも併せて見る。
	 */
	private isSheltered(foot: Position): boolean {
		// 蓋がある。これが本来の潜れた形。
		//
		// 葉や幹は蓋ではない。木の下に立っているだけで「潜れた」と読み、
		// 森の中で4分間突っ立ったままスケルトンに撃たれた(実測 2026-09-20
		// 20:40〜20:44、原木を切った直後の日没)。矢は葉を抜けないが、
		// スケルトンは横から歩いて来る。
		const above = this.driver.world.blockAt({ ...foot, y: foot.y + 2 });
		if (above && above.name !== "air" && !isTreeBlockName(above.name)) return true;

		// 蓋が無くても、足元の高さが四方とも塞がっていれば穴の中にいる。
		// 地上に立っているときはここが空くので、掘る前と後を取り違えない。
		const sides = [
			{ x: 1, z: 0 },
			{ x: -1, z: 0 },
			{ x: 0, z: 1 },
			{ x: 0, z: -1 },
		];
		return sides.every(
			(d) => this.driver.world.blockAt({ x: foot.x + d.x, y: foot.y, z: foot.z + d.z })?.solid,
		);
	}

	/**
	 * 足元を掘って潜り、頭上を塞ぐ。
	 *
	 * 装備が無いうちは走って逃げても追いつかれる。1マス潜って蓋をすれば
	 * 地上の敵はまず届かない。塞ぐ物が無ければ潜るだけでも当たりにくくなる。
	 */
	private async burrow(signal: AbortSignal): Promise<boolean> {
		const { driver } = this;
		const pos = driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		const below = { x: foot.x, y: foot.y - 1, z: foot.z };
		const block = driver.world.blockAt(below);
		if (!block || !block.diggable || block.name === "air") return false;
		// 水や溶岩は掘っても穴にならない。流れ込むか、落ちて死ぬ。
		if (block.name === "water" || block.name === "lava") return false;

		// 掘った先が空洞なら潜らない。
		//
		// 「1マス潜って蓋をする」つもりの穴が、洞窟の天井に空けた落とし穴に
		// なっていた。掘る先の下を見ていなかったため。9/5〜9/11 の死因606件の
		// うち death.fell が146件(24%)、落ちた先は暗い洞窟なので、そこで
		// さらに mob に殺されて持ち物ごと失う。潜れないなら潜らない方がよい。
		const unsafe = this.burrowHazardBelow(below);
		if (unsafe) {
			this.log(`[反射] 潜るのをやめる（${unsafe}）`);
			return false;
		}
		// 隣が水なら掘らない。掘った穴に水が流れ込み、蓋の下で溺れる(実測
		// 2026-09-21 02:00、クレーターの水際で潜って溺死)。足元の高さと、
		// 掘る先の高さの四方を見る。
		for (const d of BOX_DIRECTIONS) {
			for (const y of [foot.y, below.y]) {
				const side = driver.world.blockAt({ x: foot.x + d.x, y, z: foot.z + d.z });
				if (side && (side.name === "water" || side.name === "flowing_water")) {
					this.log("[反射] 潜るのをやめる（隣に水。掘れば流れ込む）");
					return false;
				}
			}
		}

		this.log("[反射] 潜って身を隠す");
		try {
			// マスの中央に寄ってから掘る。体の幅は 0.6 あり、マスの端に立っている
			// と足元を掘っても隣のブロックに乗ったまま落ちない(実測 2026-09-21
			// 06:00、「掘ったが落ちていない(足元 air)」)。
			try {
				await driver.goto(
					signal,
					{ kind: "xz", x: foot.x + 0.5, z: foot.z + 0.5, distance: 0.25 },
					{ timeoutMs: 3_000 },
				);
			} catch (e) {
				// 寄れないまま掘ると、縁に立ったまま足場だけが消える。斜面では
				// そこから滑り落ちる(実測 2026-09-21 09:19、Y=83 の山頂で
				// 「掘ったが落ちていない(足元 air)」の 6 秒後に落死)。掘らない。
				if (!signal.aborted) this.log(`[反射] マスの中央に寄れないので掘らない: ${e}`);
				return false;
			}
			await driver.equipBestTool(below);
			await driver.dig(signal, below);
			// 掘った穴へ落ちるのを待つ。落ちたかは足の高さで確かめる。掘れて
			// いない・落ちていないのに蓋を試すと「四方すべて空気」で失敗する
			// (実測 2026-09-21 05:40、平地に立ったまま 2 回「潜った」ことになった)。
			let dropped = false;
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 500));
				if (Math.floor(driver.getState().position.y) < foot.y) {
					dropped = true;
					break;
				}
			}
			if (!dropped) {
				const b = driver.world.blockAt(below);
				this.log(
					`[反射] 掘ったが落ちていない(足元 ${b?.name ?? "?"}、Y=${Math.floor(driver.getState().position.y)})`,
				);
				return false;
			}
		} catch (e) {
			// 黙って諦めると「潜って身を隠す」が毎分並ぶだけで何も分からない
			// (実測 2026-09-21 08:21〜08:23、4 回並んで蓋の記録が無いまま矢で死亡)。
			if (!signal.aborted) this.log(`[反射] 潜れなかった: ${e}`);
			return false;
		}

		// 2 マス目。1 マスだけでは頭が地上に出ていて、ゾンビの手が届き、蓋の支えも
		// 無い(実測 2026-09-21 03:19〜03:20、1 マスの穴で蓋が置けず、ゾンビに殺された)。
		// 2 マス潜れば頭が地面の高さに入り、蓋は地面に 1 個積んだ支えで置ける。
		{
			const p2 = driver.getState().position;
			const foot2 = { x: Math.floor(p2.x), y: Math.floor(p2.y), z: Math.floor(p2.z) };
			const below2 = { x: foot2.x, y: foot2.y - 1, z: foot2.z };
			const b2 = driver.world.blockAt(below2);
			const wet = BOX_DIRECTIONS.some((d) => {
				const s = driver.world.blockAt({ x: foot2.x + d.x, y: below2.y, z: foot2.z + d.z });
				return !!s && (s.name === "water" || s.name === "flowing_water");
			});
			if (
				foot2.y < foot.y &&
				b2 &&
				b2.diggable &&
				b2.name !== "air" &&
				b2.name !== "water" &&
				b2.name !== "lava" &&
				!wet &&
				!this.burrowHazardBelow(below2)
			) {
				try {
					await driver.equipBestTool(below2);
					await driver.dig(signal, below2);
					await new Promise((r) => setTimeout(r, 600));
				} catch {
					// 1 マスのままでも蓋は試す。
				}
			}
		}

		// 頭上に蓋をする。置ける物が無ければ潜っただけで済ませる。
		await this.capHead(signal);
		return true;
	}

	/**
	 * 蓋や壁に使う物を手に持つ。一番多く持っている物を選ぶ。支えを積むと
	 * 2〜3 個使うので、少ない山を選ぶと蓋の前に尽きる。置くたびに持ち直し、
	 * 尽きたら次の山へ移る。無ければ false。
	 */
	private async holdCover(): Promise<boolean> {
		const cover = this.driver.inventory
			.items()
			.filter((i) => PLACEABLE_COVER.some((n) => i.name.endsWith(n)))
			.sort((a, b) => b.count - a.count)[0];
		if (!cover) return false;
		await this.driver.equip(cover.name, "hand");
		return true;
	}

	/** 持ち直してから置く。置ける物が無ければ投げる。 */
	private async placeCover(signal: AbortSignal, at: Position, face: Position): Promise<void> {
		if (!(await this.holdCover())) throw new Error("置ける物が尽きた");
		await this.driver.placeBlock(signal, at, face);
	}

	/**
	 * 足の高さと頭の高さの四方で、空いているマスを塞ぐ。
	 *
	 * 蓋があっても横が開いていれば矢は入る。実測 2026-09-21 11:00、支えを積んで
	 * 蓋を置いた穴の中で、夜明け前にスケルトンに 3 発撃たれて死亡(体力 9→5→1)。
	 * 07:01 と 08:23 の矢の死も「籠っているのに削られた」の後。置く先は、その
	 * マスの下(固い床の上)か、その奥(こちら向きの面)。塞げた数を返す。
	 */
	private async sealSides(signal: AbortSignal): Promise<number> {
		const { driver } = this;
		if (!(await this.holdCover())) return 0;
		const pos = driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		let sealed = 0;
		const open: string[] = [];
		for (const d of BOX_DIRECTIONS) {
			for (const y of [foot.y, foot.y + 1]) {
				const cell = { x: foot.x + d.x, y, z: foot.z + d.z };
				const b = driver.world.blockAt(cell);
				if (!b || b.solid) continue;
				if (b.name === "water" || b.name === "lava") continue;
				try {
					const below = driver.world.blockAt({ ...cell, y: y - 1 });
					const beyond = driver.world.blockAt({ x: cell.x + d.x, y, z: cell.z + d.z });
					if (below?.solid) {
						await this.placeCover(signal, { ...cell, y: y - 1 }, { x: 0, y: 1, z: 0 });
					} else if (beyond?.solid) {
						await this.placeCover(
							signal,
							beyond.position ?? { x: cell.x + d.x, y, z: cell.z + d.z },
							{
								x: -d.x,
								y: 0,
								z: -d.z,
							},
						);
					} else {
						open.push(`${d.x},${d.z}@${y - foot.y}`);
						continue;
					}
					await new Promise((r) => setTimeout(r, 300));
					if (driver.world.blockAt(cell)?.solid) sealed++;
					else open.push(`${d.x},${d.z}@${y - foot.y}`);
				} catch (e) {
					this.log(`[反射] 横を塞げなかった: ${e}`);
					return sealed;
				}
			}
		}
		if (sealed > 0 || open.length > 0) {
			this.log(
				`[反射] 横を ${sealed} マス塞いだ${open.length > 0 ? `。塞げない: ${open.join(" ")}` : ""}`,
			);
		}
		return sealed;
	}

	/**
	 * 頭の上に蓋を置く。窪みや穴の中で、上だけが空いているときに使う。
	 *
	 * ホットバーに限らない。土 39 個を持っていても 9 番以降に入っていれば
	 * 「置ける物が無い」になり、蓋の無い穴に立ったまま矢で死んだ(実測
	 * 2026-09-21 01:41)。equip は奥の枠からでも持ち替える。支えは四方を見る。
	 */
	private async capHead(signal: AbortSignal): Promise<void> {
		const { driver } = this;
		if (!(await this.holdCover())) return;
		const place = (at: Position, face: Position) => this.placeCover(signal, at, face);
		try {
			// 蓋は頭の 1 つ上(lid)。支えは lid と同じ高さの隣。以前は頭と同じ高さの
			// 隣を支えにして「自分の頭のマス」へ置こうとしていて、置けるはずが
			// なかった(実測 2026-09-21 02:59〜03:20、写しに出ない/支えが無いの連発)。
			const here = driver.getState().position;
			const head = { x: Math.floor(here.x), y: Math.floor(here.y) + 1, z: Math.floor(here.z) };
			const lidPos = { x: head.x, y: head.y + 1, z: head.z };
			const settle = () => new Promise((r) => setTimeout(r, 400));
			const lidOk = () => {
				const lid = driver.world.blockAt(lidPos);
				return !!lid && lid.name !== "air";
			};
			// 1 段目: lid の高さに固い隣があれば、その側面に置く。
			for (const d of BOX_DIRECTIONS) {
				const support = { x: lidPos.x + d.x, y: lidPos.y, z: lidPos.z + d.z };
				if (driver.world.blockAt(support)?.solid) {
					await place(support, { x: -d.x, y: 0, z: -d.z });
					await settle();
					if (lidOk()) {
						this.log("[反射] 頭上に蓋を置いた");
						this.capFailures = 0;
						this.cappedLidAt = lidPos;
						return;
					}
				}
			}
			// 2 段目: lid の高さに支えが無い。隣の列で、足元の高さから lid の 1 つ下
			// までにある一番上の固いブロックの上に積み上げて、lid の高さまで支えを
			// 作り、その側面に蓋を置く。1 マスの穴なら 2 個、2 マスの穴なら 1 個積む。
			const foot = { x: head.x, y: head.y - 1, z: head.z };
			for (const d of BOX_DIRECTIONS) {
				const cx = head.x + d.x;
				const cz = head.z + d.z;
				let top: number | null = null;
				for (let y = lidPos.y - 1; y >= foot.y - 1; y--) {
					if (driver.world.blockAt({ x: cx, y, z: cz })?.solid) {
						top = y;
						break;
					}
				}
				if (top === null) continue;
				let ok = true;
				for (let y = top + 1; y <= lidPos.y; y++) {
					if (driver.world.blockAt({ x: cx, y, z: cz })?.solid) continue;
					await place({ x: cx, y: y - 1, z: cz }, { x: 0, y: 1, z: 0 });
					await settle();
					if (!driver.world.blockAt({ x: cx, y, z: cz })?.solid) {
						ok = false;
						break;
					}
				}
				if (!ok) continue;
				await place({ x: cx, y: lidPos.y, z: cz }, { x: -d.x, y: 0, z: -d.z });
				await settle();
				if (lidOk()) {
					this.log("[反射] 頭上に蓋を置いた(支えを積んで)");
					this.capFailures = 0;
					this.cappedLidAt = lidPos;
					return;
				}
			}
			this.capFailures++;
			const around = BOX_DIRECTIONS.map((d) => {
				const g = driver.world.blockAt({ x: head.x + d.x, y: head.y, z: head.z + d.z });
				const l = driver.world.blockAt({ x: head.x + d.x, y: lidPos.y, z: head.z + d.z });
				return `${d.x},${d.z}:${g?.name ?? "?"}/${l?.name ?? "?"}`;
			}).join(" ");
			this.log(
				`[反射] 蓋を置けなかった(${this.capFailures}回目、支えも作れない) 頭の高さ/蓋の高さの隣: ${around}`,
			);
		} catch (e) {
			this.capFailures++;
			this.log(`[反射] 蓋を置けなかった(${this.capFailures}回目): ${e}`);
		}
	}

	/**
	 * その位置を掘ったとき、落ちて困ることになるか。
	 *
	 * 困る理由を返す。問題なければ null。未取得(null)のマスは「空いている」
	 * ことの根拠にならないので、そこで打ち切って安全側に倒す。読めていない
	 * ものを空気扱いにすると、見えない穴の上で掘ってよいことになる。
	 */
	private burrowHazardBelow(dug: Position): string | null {
		let fall = 0;
		for (let y = dug.y - 1; y >= dug.y - 1 - BURROW_FALL_SCAN; y--) {
			const b = this.driver.world.blockAt({ x: dug.x, y, z: dug.z });
			if (b === null) break;
			if (b.name === "water" || b.name === "lava") return `下が ${b.name}`;
			if (b.solid) break;
			fall++;
			if (fall > BURROW_MAX_DROP) return `下が ${fall} マス以上空いている`;
		}
		return null;
	}

	/** 殴れる物を持っているか。素手で敵に向かうのは逃げるより悪い。 */
	private hasWeapon(): boolean {
		return this.driver.inventory
			.items()
			.some((i) => i.name.endsWith("_sword") || i.name.endsWith("_axe"));
	}

	/**
	 * 持っている中で一番良い防具を着る。今着ている物より良いときだけ着替える。
	 *
	 * 着替えると外れた方が持ち物へ戻る。そのため「持ち物で一番良い物」だけを
	 * 見て無条件に着せると、ダイヤを着ている状態で革を拾っただけで
	 *   革を着る → ダイヤが持ち物に戻る → ダイヤを着る → 革が戻る
	 * と反射のたびに入れ替わり続け、半分の時間は劣った方を着ることになる。
	 * 着ている物と比べて、良くなるときだけ手を出す。
	 */
	private async wearBestArmor(): Promise<void> {
		const items = this.driver.inventory.items();
		const worn = this.driver.inventory.armor();

		for (let i = 0; i < ARMOR_PIECES.length; i++) {
			const { suffix, destination } = ARMOR_PIECES[i];
			const best = items
				.filter((it) => it.name.endsWith(suffix))
				.sort((a, b) => armorRank(a.name) - armorRank(b.name))[0];
			if (!best) continue;

			// 着ていなければ着る。着ているなら、等級が上がるときだけ着替える。
			const current = worn[i];
			if (current && armorRank(current.name) <= armorRank(best.name)) continue;

			// 失敗は上(reflexSurvival の手入れ枠)で握り潰される。品名と
			// スロットは bedrock.ts の wear 側がログに出す。
			//
			// ここで resyncStackIds による取り直し+再試行を試したが、効かない
			// (2026-09-22 run-179 で差し戻した)。ブロックの設置自体は成功して
			// いるのに、着せ直しは同じ status=49 で弾かれる:
			//
			//   [wear] leather_boots ... (持ち物スロット 10 -> 防具スロット 3): status=49
			//   [wearBestArmor] 識別子を取り直すため dirt を1個置く
			//   [tryPlaceBlock] SUCCESS
			//   [wear] leather_boots ... : status=49        ← 変わらない
			//
			// 49 は FailedToValidateSrcSlot で、引くのはサイドカー側の
			// rawSlots[slot].StackNetworkID(session.go の wear ハンドラ)。
			// JS 側の一覧を取り直しても、そちらは変わらない。クラフトと
			// survival.eat で効くのは、あちらが JS 側の写しを使うため。
			// 直すならサイドカー側。効かないと分かったまま置いておくと、
			// 60 秒ごとにブロックを置いては掘るだけになる。
			await this.driver.equip(best.name, destination as any);
		}
	}

	/**
	 * 最強の武器（剣、なければ斧）をホットバー／手元に装備する。
	 *
	 * 持ち物の奥にあってもホットバーへ移されないと、サイドカーの
	 * 迎撃反射(defendLocked)が武器を使えず、丸腰扱いで逃げ回ることになる。
	 */
	private async equipBestWeapon(): Promise<void> {
		const items = this.driver.inventory.items();
		const rank = [
			"diamond_sword",
			"iron_sword",
			"stone_sword",
			"wooden_sword",
			"diamond_axe",
			"iron_axe",
			"stone_axe",
			"wooden_axe",
		];
		const best = items
			.filter((it) => rank.includes(it.name))
			.sort((a, b) => rank.indexOf(a.name) - rank.indexOf(b.name))[0];
		if (!best) return;

		// 既にホットバー(0-8)にあればサイドカーが自動で持ち替えるので、
		// 奥(9-35)にあるときだけホットバーへ移す。
		if (best.slot > 8 && best.slot <= 35) {
			await this.driver.equip(best.name, "hand");
		}
	}

	/**
	 * 四方を塞がれていたら掘って出る。
	 *
	 * 経路探索は掘って抜ける手も持っているが、それは目標がある時の話で、
	 * 「どこへ行けばいいか分からないが動けない」状態は自力で解けない。
	 */
	private async escapeIfBoxedIn(signal: AbortSignal): Promise<void> {
		const { driver } = this;
		const pos = driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		const dirs = [
			{ x: 1, z: 0 },
			{ x: -1, z: 0 },
			{ x: 0, z: 1 },
			{ x: 0, z: -1 },
		];

		const open = (dx: number, dz: number) => {
			const f = driver.world.blockAt({ x: foot.x + dx, y: foot.y, z: foot.z + dz });
			const h = driver.world.blockAt({ x: foot.x + dx, y: foot.y + 1, z: foot.z + dz });
			// 未取得(null)は「塞がれている」と決めつけない。掘る理由にしない。
			if (f === null || h === null) return true;
			// 通れるかは .solid で見る。name === "air" だと、水・海草・シダ・ツタ・
			// 積雪の上に立っているだけで「四方塞がり」に化ける。同じファイルの
			// isSheltered / sealSides / hasRoof / burrow は全部 .solid なので、
			// ここだけ基準が違っていた。
			//
			// 実測 2026-09-21(run-165〜171)、escape_boxed_in が掘った先に
			// seagrass 6 / fern 2 / large_fern 1 / brown_mushroom 2 = 11件の
			// 通れるブロックが混ざっていた。塞がれてなどいなかった。
			return !f.solid && !h.solid;
		};

		if (dirs.some((d) => open(d.x, d.z))) return;

		// 掘り広げ続けない。
		//
		// 自分が掘った縦穴の中では四方が塞がった判定が常に成立するので、
		// 歯止めが無いと横へ掘り続けて穴が広がる。実測で579回発火しており、
		// 初期リス周辺が荒れた最大の出どころがこれだった。
		// 掘る間隔は裁定者が持つ(保持とクールダウン)。ここで二重に止めると、
		// 担当を握ったまま1マスも掘らない時間ができる。実測 2026-09-17 12:45、
		// 30秒の保持を2回取って、その間ずっと何もしていなかった。
		if (Date.now() - this.lastEscapeDigAt < ESCAPE_DIG_MIN_GAP_MS) return;

		// 全方向が塞がっている。壊せるものを1つ選んで抜ける。
		for (const d of dirs) {
			const target = { x: foot.x + d.x, y: foot.y, z: foot.z + d.z };
			const block = driver.world.blockAt(target);
			if (!block || !block.diggable) continue;
			this.log(`[反射] 四方を塞がれているので ${block.name} を掘って出る`);
			this.lastEscapeDigAt = Date.now();
			try {
				await driver.equipBestTool(target);
				await driver.dig(signal, target);
				// 頭の高さも空けないと通れない。
				const head = { ...target, y: target.y + 1 };
				const above = driver.world.blockAt(head);
				if (above?.solid && above.diggable) {
					await driver.dig(signal, head);
				}
				return;
			} catch {
				// この方向は駄目だった。次を試す。
			}
		}
	}

	private async ensureOnLand(signal: AbortSignal): Promise<void> {
		// ブロック読み取りに依存するため Java 版限定。統合版は world 未実装。
		if (!this.isJava) return;
		const { bot } = this;
		if (!bot.entity) return;
		const pos = bot.entity.position;
		const blockAtFeet = bot.blockAt(pos);
		const blockAtHead = bot.blockAt(pos.offset(0, 1, 0));

		const isInWater = (b: any) => b && b.name === "water";
		if (!isInWater(blockAtFeet) && !isInWater(blockAtHead)) {
			return;
		}

		this.log("Agent is in water, finding nearest land...");

		const searchRadius = 16;
		for (let r = 1; r <= searchRadius; r++) {
			for (let dx = -r; dx <= r; dx++) {
				for (let dz = -r; dz <= r; dz++) {
					for (let dy = -2; dy <= 4; dy++) {
						const checkPos = pos.offset(dx, dy, dz);
						const feet = bot.blockAt(checkPos);
						const head = bot.blockAt(checkPos.offset(0, 1, 0));

						if (
							feet &&
							!isInWater(feet) &&
							feet.name !== "air" &&
							head &&
							!isInWater(head) &&
							head.name === "air"
						) {
							this.log(`Found land at ${checkPos}, moving...`);
							try {
								// .floored() で整数化したあと、0.5を足して中心を指定する
								const targetX = Math.floor(checkPos.x) + 0.5;
								const targetY = Math.floor(checkPos.y); // Yは足元なので整数のままでOK
								const targetZ = Math.floor(checkPos.z) + 0.5;

								const goal = new goals.GoalNear(targetX, targetY, targetZ, 1);
								await this.abortableGoto(signal, goal);

								this.log("Moved to land successfully");
								return;
							} catch (err) {
								if (err instanceof Error) {
									this.log(`Failed to move to land at ${checkPos}: ${err.message}`);
									if (err.stack) {
										console.error("Pathfinding error stack:", err.stack);
									}
								}
							}
						}
					}
				}
			}
		}
		this.log("Could not find nearby land");
	}
}
