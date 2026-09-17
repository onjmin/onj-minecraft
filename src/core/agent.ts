import fs from "node:fs";
import path from "node:path";
import mineflayer, { type ControlState } from "mineflayer";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import type { AgentProfile } from "../profiles/types";
import { craftWeaponSkill } from "../skills/crafting/weapon";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gotoSurfaceSkill } from "../skills/goto/surface";
import { gainedSince, snapshotInventory, totalGain } from "../skills/inventory-delta";
import { giveItemSkill } from "../skills/social/give";
import { secureFoodSkill } from "../skills/survival/food";
import type { SkillResponse } from "../skills/types";
import { type ChatSituation, Conversation } from "./conversation";
import { EAT_BELOW_FOOD, pickCookable, pickFood } from "./driver/food";
import { JavaDriver } from "./driver/java";
import type { BotDriver, Position } from "./driver/types";
import { fetchMinecraftKnowledge } from "./knowledge/wiki";
import { chatLlm, llm } from "./llm-client";
import { parseLlmOutput } from "./llm-output-parser";
import { createPerceptionSnapshot, type DamageInfo } from "./perception";
import { buildThinkingPrompt } from "./prompt-builder";
import { SurvivalArbiter } from "./survival/arbiter";
import { SurvivalMetrics } from "./survival/metrics";
import {
	BURIED_THICKNESS,
	DEATH_STORM_LIMIT,
	DEEP_UNDERGROUND_GAP,
	HUNT_RANGE,
	SHELTER_HEALTH,
	type SurvivalActions,
} from "./survival/rules";
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
const MIN_UNINTERRUPTED_MS = envNum("SKILL_MIN_RUN_MS", 60_000);

/** これを下回ったら戦わずに逃げる。 */
const _FLEE_HEALTH = envNum("FLEE_HEALTH", 10);
/** 死亡地点の落とし物を追いかける制限時間。落下物は5分ほどで消える。 */
const DEATH_LOOT_WINDOW_MS = envNum("DEATH_LOOT_WINDOW_MS", 240_000);
/** 回収に戻って返り討ちに遭ったあと、次に試すまで置く間隔。 */
const RECOVER_COOLDOWN_MS = envNum("RECOVER_COOLDOWN_MS", 45_000);
/** プレイヤーに殴られてから、人に近づかないでおく時間。 */
const PLAYER_HOSTILITY_MS = envNum("PLAYER_HOSTILITY_MS", 120_000);
/** 一度の反射で振る回数。振り続けて本来の行動を止めない程度に。 */
const _ATTACK_SWINGS = 4;
/** 頭上の蓋に使える物。何でもよいが、貴重な物を使わないよう絞る。 */
const PLACEABLE_COVER = ["dirt", "cobblestone", "stone", "_planks", "gravel", "sand", "netherrack"];
/** 防具かどうかの判定に使う。 */
const ARMOR_SUFFIXES = ["_helmet", "_chestplate", "_leggings", "_boots"];
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
function isNightTime(timeOfDay: number): boolean {
	return timeOfDay >= 13000 && timeOfDay <= 23000;
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
const UNARMED_RECOVERY_MAX_DEPTH = envNum("UNARMED_RECOVERY_MAX_DEPTH", 12);
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

/** 同じ死亡地点へ取りに行く回数の上限。超えたら諦める。 */
const RECOVERY_ATTEMPT_LIMIT = envNum("RECOVERY_ATTEMPT_LIMIT", 2);
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
	private knownLandmarks: { position: Position; name: string; at: number }[] = [];
	/** 最後に人工物を探した時刻。全走査に振れうるので間隔を空ける。 */
	private lastLandmarkScanAt = 0;
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
	private readonly arbiter = new SurvivalArbiter({ log: (m) => this.log(m) });
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
	/** 思考ループの待ちを途中で切り上げるための呼び出し口。 */
	private wakeThinking: (() => void) | null = null;
	/**
	 * スキルごとの成否の記録。
	 *
	 * 「成功と報告するが何も得ていない」スキルを、実績で落とすために持つ。
	 * 本番では collecting.stone が「10個収集」と返しながら持ち物が空だった。
	 * ああいうものを人が気付くまで選ばせ続けるのは無駄が大きい。
	 */
	private skillStats = new Map<string, { ok: number; fail: number }>();

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
			this.loadHome();
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
			this.driver.on("death", () => {
				this.noteDeath();
				this.noteDeathPlace(this.driver.getState().position);
				// 回収に戻った先で殺されたなら、まだ敵がそこにいる。
				// 諦めはしないが、すぐ戻ると同じことになる。間を置く。
				// 実測で90秒に4回、ほぼ同じ座標で死に続けた。戻るたびに
				// 拾い直した物をまた落とすので、往復するほど損をする。
				if (this.currentTaskName === gotoDeathPointSkill.name && this.deathPoint) {
					this.log("[反射] 回収に戻った先で死んだ。敵が離れるまで待つ");
					this.deathPoint.retryAfter = Date.now() + RECOVER_COOLDOWN_MS;
					this.currentTaskName = exploreLandSkill.name;
					this.currentTaskSince = Date.now();
					return;
				}
				this.deathPoint = { position: { ...this.driver.getState().position }, at: Date.now() };
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
				if (!this.getDeathPoint()) return;
				// 取りに行くかどうかは裁定者の recover_loot が決める。ここで
				// 直に動かすと、丸腰・深さ・試行回数の歯止めも、担当の期限も
				// 素通りして、さっき殺された穴へまっすぐ戻ることになる。
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
		// 統合版と同じく、壊したものを控える。
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
		if (wake) wake();
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

	/** 死んだ場所。取りに行く価値があるうちだけ返す。 */
	public getDeathPoint(): Position | null {
		if (!this.deathPoint) return null;
		if (Date.now() - this.deathPoint.at > DEATH_LOOT_WINDOW_MS) {
			// 落下物はもう消えている。追いかけるだけ無駄。
			this.deathPoint = null;
			return null;
		}
		// 直前に返り討ちに遭ったなら、少し置いてから。
		if (this.deathPoint.retryAfter && Date.now() < this.deathPoint.retryAfter) return null;
		return this.deathPoint.position;
	}

	public clearDeathPoint(): void {
		this.deathPoint = null;
	}

	/**
	 * いま提示する価値があるスキルか。
	 *
	 * 前提が明らかに満たせないものを一覧から外す。LLM に選ばせて即失敗
	 * させるのは、思考を1周まるごと捨てるのと同じ。
	 */
	private skillIsWorthOffering(name: string): boolean {
		switch (name) {
			case gotoDeathPointSkill.name:
				// 落とし物が無いなら行き先が無い。
				return this.getDeathPoint() !== null;
			case "collecting.hunting": {
				// 動物が見えないなら狩れない。
				const prey = ["cow", "pig", "sheep", "chicken", "rabbit"];
				return this.driver.nearbyEntities(32).some((e) => prey.includes(e.name));
			}
			case "collecting.stone":
			case "collecting.mining": {
				// ツルハシが無いなら石も鉱石も落ちない。壊せはするので、
				// スキルは動いて何も得ずに終わる。実測 2026-09-16、
				// 「Broke 4 stone blocks but obtained nothing」を返しながら
				// LLM はこれを選び続け、その間ずっと地下にいた。壊した跡だけが
				// 残る。前提はこちらで判るので、こちらで落とす。
				return this.driver.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
			}
			case "collecting.wood": {
				// 地下深くに木は生えていない。掘って出るのが先で、ここで
				// 選ばせても空振りする。同日、Y=34 で選ばれていた。
				// 深さが分からないときは出す(地上にいる可能性の方が高い)。
				const depth = this.lastKnownDepth();
				return !(depth !== null && depth > DEEP_UNDERGROUND_GAP);
			}
			case "crafting.tool":
			case "crafting.weapon":
			case "crafting.torch": {
				// 棒か、棒になる木を持っていなければ何も作れない。
				// 実測で crafting.tool が10分に21回選ばれ、全部
				// 「棒が要る」で即失敗していた。
				return this.driver.inventory.items().some(
					(i) =>
						i.name === "stick" ||
						i.name.endsWith("_planks") ||
						i.name.endsWith("_log") ||
						i.name.endsWith("_wood") ||
						// ネザーの木(crimson_stem / warped_stem)も板材になる。
						// ここだけ抜けていたので、ネザーの木しか持っていないと
						// クラフト系が一覧から丸ごと消えていた。
						i.name.endsWith("_stem"),
				);
			}
			case "survival.secure_food": {
				// 食べる物も、焼ける物も、狩れる相手もいないなら出さない。
				//
				// ローカルの採点で捕まえた。動物のいない場所で LLM がこれを選び、
				// 「No animals found nearby」で30秒に9回即失敗していた。
				// 出来ない行動を一覧に出しておくのは、選ばせて失敗させるのと同じ。
				const names = this.driver.inventory.items().map((i) => i.name);
				if (pickFood(names) !== null || pickCookable(names) !== null) return true;
				return this.driver.nearbyEntities(HUNT_RANGE).some((e) => PREY_NAMES.has(e.name));
			}
			case "crafting.smelting": {
				// かまどか、かまどになる丸石が要る。
				const items = this.driver.inventory.items();
				return items.some(
					(i) => i.name === "furnace" || i.name === "cobblestone" || i.name === "blackstone",
				);
			}
			case "goto.landmark":
				// 一度も人工物を見ていないなら行き先が無い。
				return this.getKnownLandmarks().length > 0;
			case "goto.player": {
				// 殴られた直後は近づかない。誰もいないなら行き先が無い。
				if (this.wasAttackedByPlayerRecently()) return false;
				return this.driver.nearbyEntities(64).some((e) => e.kind === "player");
			}
			case "social.give": {
				// 渡す相手も渡す物も無いなら選ばせない。空の持ち物で
				// 「渡そうか」と申し出て、実行の段になって初めて
				// 「何も持っていません」で失敗するのを避ける。
				if (this.wasAttackedByPlayerRecently()) return false;
				const hasPlayer = this.driver.nearbyEntities(64).some((e) => e.kind === "player");
				const hasItem = this.driver.inventory.items().length > 0;
				return hasPlayer && hasItem;
			}
			default:
				return true;
		}
	}

	private recordSkillOutcome(name: string, ok: boolean) {
		const st = this.skillStats.get(name) ?? { ok: 0, fail: 0 };
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
	private skillReliability(name: string): { tried: number; rate: number } | null {
		const st = this.skillStats.get(name);
		if (!st) return null;
		const tried = st.ok + st.fail;
		if (tried === 0) return null;
		return { tried, rate: st.ok / tried };
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

					let result: SkillResponse | undefined;

					const args = this.currentSkillArgs[skill.name] || {};

					// 引数の要るスキルを、引数無しで掴まされていないか。
					//
					// LLM が "Skill: goto.coords" とだけ返すことがある。その
					// まま走らせると「座標が未指定」で即失敗し、次の思考まで
					// 秒3回それを繰り返す。実測 2026-09-13、14:08 台の
					// ログはこれで埋まっていた。選び直す方が早い。
					if (
						skill.inputSchema &&
						Object.keys(skill.inputSchema).length > 0 &&
						Object.keys(args).length === 0
					) {
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
					{
						const gained = gainedSince(this.driver, inventoryBefore);
						const to = this.driver.getState().position;
						const moved = Math.hypot(
							to.x - positionBefore.x,
							to.y - positionBefore.y,
							to.z - positionBefore.z,
						);
						const changed = totalGain(gained) > 0 || moved > 1;
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
					if (!result.success) this.log(`${skill.name} 失敗: ${result.summary}`);
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
					if (!result.success) await new Promise((r) => setTimeout(r, 2000));

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
				const state = this.getAgentStateForThinking();
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
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.wakeThinking = null;
					resolve();
				}, wait);
				this.wakeThinking = () => {
					clearTimeout(timer);
					resolve();
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
			// 何度試しても駄目だったものを、判断できない状態で選び直しても同じ。
			const rel = this.skillReliability(name);
			return !(rel && rel.tried >= 3 && rel.rate < 0.2);
		});
		if (candidates.length === 0) return;

		const next = candidates[Math.floor(Math.random() * candidates.length)];
		this.log(`[思考停止] LLM に繋がらないので ${next} に切り替える`);
		this.currentTaskName = next;
		this.currentTaskSince = Date.now();
		this.instantRepeats = 0;
	}

	private getAgentStateForThinking() {
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
				const note =
					rel && rel.tried >= 3
						? ` [これまで ${rel.tried} 回試して成功率 ${Math.round(rel.rate * 100)}%${
								rel.rate < 0.2 ? "。ほぼ失敗している。別の手を先に試すこと" : ""
							}]`
						: "";
				return {
					name: t.name,
					description: t.description + note,
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
			spawnBed: this.spawnBed
				? `(${this.spawnBed.x}, ${this.spawnBed.y}, ${this.spawnBed.z})`
				: undefined,
			skills: skillsContext,
			stallNotes: this.getStallNotes(),
			allowSpontaneousChat: process.env.ENABLE_CHAT === "1",
			pendingRequest,
			lastDamageCause: this.lastDamageCause,
			memorySummary: historyText,
		};
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

			const spinning = this.instantRepeats >= SPIN_LIMIT;
			const tooEarlyToSwitch =
				!isSameTask &&
				!wasHumanRequest &&
				!spinning &&
				this.currentTaskSince > 0 &&
				owningMs < MIN_UNINTERRUPTED_MS;
			if (tooEarlyToSwitch && !ranTooLong) {
				this.log(
					`${this.currentTaskName} を継続します（担当 ${Math.round(owningMs / 1000)}秒、${foundSkillName} への切り替えは保留）`,
				);
				return;
			}

			if (!isSameTask || ranTooLong) {
				if (isSameTask) {
					this.log(`${foundSkillName} が長すぎるため中断します`);
				}
				this.cancelCurrentExecution();
			}
			if (this.currentTaskName !== foundSkillName) {
				this.currentTaskName = foundSkillName;
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
			await this.wearBestArmor();
			await this.equipBestWeapon();
			// 見かけた建物を控える。地上に出たとき、向かう先として使う。
			await this.noteLandmarksNearby();
			// 昼のうちにベッドを叩いてリスポーン地点を移しておく。
			await this.registerSpawnAtBed(signal);
			// 待たせず自分から動く。await しない: LLM 呼び出しを含むので、
			// ここで待つと反射ループそのものが詰まる。
			this.maybeGreetNearbyPlayer();

			const snapshot = await this.buildSurvivalSnapshot();
			const decision = await this.arbiter.tick(snapshot, this.survivalActions, signal);
			this.metrics.noteTick(snapshot, decision.rule?.name ?? null);
			this.metrics.reportIfDue(METRICS_REPORT_MS);
			return decision.rule !== null;
		} catch (e) {
			// 反射行動で本来の行動を止めない。
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
		// 着ている防具は items() に出てこない。持ち物だけを見ると、
		// フル装備でも「丸腰」と判定されて毎晩潜ることになる。
		const armored =
			this.driver.inventory.armor().some((i) => i !== null) ||
			names.some((n) => ARMOR_SUFFIXES.some((suf) => n.endsWith(suf)));
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
			inventoryCount: items.length,
			recentDeaths: this.countRecentDeaths(),
			deathPoint: point ? { ...point } : null,
			homeDistance: this.spawnBed ? distanceTo(this.spawnBed) : null,
			sleepRequested: Date.now() - this.othersSleepingAt <= SLEEP_REQUEST_TTL_MS,
			humanRequestFresh: this.hasFreshHumanRequest(),
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
		secureFood: (signal: AbortSignal) => this.runSurvivalSkill(secureFoodSkill, signal),
		shelter: (signal: AbortSignal) => this.shelterNow(signal),
		goToSurface: async (signal: AbortSignal) => {
			await this.runSurvivalSkill(gotoSurfaceSkill, signal);
		},
		escapeBoxedIn: (signal: AbortSignal) => this.escapeIfBoxedIn(signal),
		recoverLoot: (signal: AbortSignal) => this.recoverLootNow(signal),
		sleep: (signal: AbortSignal) => this.sleepIfOthersSleeping(signal),
		armSelf: async (signal: AbortSignal) => {
			await this.runSurvivalSkill(craftWeaponSkill, signal);
		},
	};

	/**
	 * 生存側がスキルを1回動かす。
	 *
	 * 成否だけでなく「世界が変わったか」を見る。成功を返しても持ち物も位置も
	 * 変わっていないなら空振りで、実測 2026-09-15 の crafting.weapon は
	 * 材料が同じまま792回それを繰り返していた。空振りは計測に残し、
	 * 思考にも覚え書きとして渡す。
	 */
	private async runSurvivalSkill(
		skill: { name: string; handler: (a: any) => Promise<SkillResponse<any>> },
		signal: AbortSignal,
	): Promise<boolean> {
		const before = snapshotInventory(this.driver);
		const from = this.driver.getState().position;
		const startedAt = Date.now();
		let ok = false;
		try {
			const result = await skill.handler({ agent: this, signal, args: {} });
			ok = result.success;
			if (!ok) this.log(`[生存] ${skill.name} 失敗: ${result.summary}`);
		} catch (e) {
			if (!signal.aborted) this.log(`[生存] ${skill.name} 失敗: ${e}`);
		}
		const gained = gainedSince(this.driver, before);
		const to = this.driver.getState().position;
		const moved = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
		const changed = totalGain(gained) > 0 || moved > 1;
		this.metrics.noteSkill(skill.name, ok, changed, totalGain(gained), Date.now() - startedAt);
		if (ok && !changed) {
			this.noteStall(
				`${skill.name} reported success but nothing changed (no items gained, no movement).`,
			);
		}
		return ok;
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
	private async shelterNow(signal: AbortSignal): Promise<void> {
		if (await this.retreatToHome(signal)) return;
		const pos = this.driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		if (this.isSheltered(foot) || this.solidAboveCount(foot) >= BURIED_THICKNESS) return;
		// 掘り進み続けないための歯止め。ただし敵が目の前にいるときは待たない。
		const threatened = this.driver
			.nearbyEntities(HOME_THREAT_RADIUS)
			.some((e) => isHostileMob(e.name));
		if (!threatened && Date.now() - this.lastBurrowAt < BURROW_COOLDOWN_MS) return;
		this.lastBurrowAt = Date.now();
		await this.burrow(signal);
	}

	/** 落とし物を取りに行く。割に合わないと分かった時点で諦める。 */
	private async recoverLootNow(signal: AbortSignal): Promise<void> {
		const point = this.getDeathPoint();
		if (!point) return;
		if (this.isNearRecentDeath(point)) {
			this.log("[生存] 落とし物はさっき殺された場所にある。近づかない");
			this.clearDeathPoint();
			return;
		}
		const depth = this.driver.getState().position.y - point.y;
		if (!this.hasWeapon() && depth > UNARMED_RECOVERY_MAX_DEPTH) {
			this.log(`[生存] 落とし物は ${Math.round(depth)} マス下。丸腰では取りに行かない`);
			this.clearDeathPoint();
			return;
		}
		const attempts = this.deathPoint?.attempts ?? 0;
		if (attempts >= RECOVERY_ATTEMPT_LIMIT) {
			this.log(`[生存] 落とし物の回収を ${attempts} 回試した。諦める`);
			this.clearDeathPoint();
			return;
		}
		const ok = await this.runSurvivalSkill(gotoDeathPointSkill, signal);
		// 数えるのは「試した回数」。担当している間ずっと数えると数周で
		// 上限に達してしまうので、失敗した回だけ数える。
		if (!ok && this.deathPoint) this.deathPoint.attempts = attempts + 1;
	}

	/** 四方が塞がっていて歩いて出られないか。 */
	private isBoxedIn(foot: Position): boolean {
		const open = (dx: number, dz: number) => {
			const f = this.driver.world.blockAt({ x: foot.x + dx, y: foot.y, z: foot.z + dz });
			const h = this.driver.world.blockAt({ x: foot.x + dx, y: foot.y + 1, z: foot.z + dz });
			if (f === null || h === null) return true;
			return f.name === "air" && h.name === "air";
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
		const myX = Math.floor(state.position.x);
		const myY = Math.floor(state.position.y);
		const myZ = Math.floor(state.position.z);
		let depth: number | null = null;
		try {
			const columns = await this.driver.world.surfaceScan(SURFACE_PROBE_RADIUS);
			// 自分の列が返るとは限らない。読めていない列は返らないので、
			// 見つからなければ一番近い列で代用する。
			const mine =
				columns.find((c) => c.x === myX && c.z === myZ) ??
				columns
					.slice()
					.sort((a, b) => Math.hypot(a.x - myX, a.z - myZ) - Math.hypot(b.x - myX, b.z - myZ))[0];
			if (mine) depth = mine.y - myY;
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
			if (above.name !== "air") solidAbove++;
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
			await this.driver.activateBlock(bed.position);
			this.lastBedActivatedAt = Date.now();
			// 寝た時点でリスポーン地点もそこへ移る。登録し直す反射
			// (registerSpawnAtBed)が同じベッドへもう一度歩かないよう控える。
			this.spawnBed = { ...bed.position };
			this.lastSpawnBedAt = Date.now();
			this.saveHome();
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
			await this.activateBedWithRetry(signal, bed.position);
			this.spawnBed = { ...bed.position };
			this.saveHome();
			this.log("[反射] リスポーン地点を登録した");
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

		const now = Date.now();
		for (const b of found) {
			// 同じ建物の中の別のブロックを何個も覚えない。粗い格子でまとめる。
			const key = (p: Position) =>
				`${Math.floor(p.x / LANDMARK_GRID)},${Math.floor(p.y / LANDMARK_GRID)},${Math.floor(p.z / LANDMARK_GRID)}`;
			const k = key(b.position);
			const existing = this.knownLandmarks.find((l) => key(l.position) === k);
			if (existing) {
				existing.at = now;
				continue;
			}
			this.knownLandmarks.push({ position: { ...b.position }, name: b.name, at: now });
			this.log(
				`[記憶] 人工物を見つけた: ${b.name} (${b.position.x}, ${b.position.y}, ${b.position.z})`,
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
				.sort(
					(a, b) =>
						Math.hypot(a.position.x - here.x, a.position.z - here.z) -
						Math.hypot(b.position.x - here.x, b.position.z - here.z),
				)
				.map((l) => ({ position: l.position, name: l.name }))
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
		// 死んだら状況は作り直される。担当も持ち越さない。
		this.arbiter.reset();
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
	private async activateBedWithRetry(signal: AbortSignal, at: Position): Promise<void> {
		try {
			await this.driver.activateBlock(at);
			return;
		} catch (e) {
			if (signal.aborted) throw e;
			this.log(`[反射] ベッドに届かない。寄り直す: ${e}`);
		}
		await this.driver.goto(signal, { kind: "near", position: at, distance: 1 });
		await this.driver.activateBlock(at);
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
			(l) => BED_NAMES.includes(l.name) && !this.isBedAvoided(l.position),
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
		const usable = beds.filter((b) => !this.isBedAvoided(b.position));
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
			await this.driver.activateBlock(home);
			this.lastBedActivatedAt = Date.now();
			// 統合版はベッドを叩いた時点でリスポーン地点が移る。ここで
			// 登録できたことになるので、帰る先として覚え直す。
			this.spawnBed = { ...home };
			this.saveHome();
			this.log("[反射] 寝床に入る");
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
		const above = this.driver.world.blockAt({ ...foot, y: foot.y + 2 });
		if (above && above.name !== "air") return true;

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
	private async burrow(signal: AbortSignal): Promise<void> {
		const { driver } = this;
		const pos = driver.getState().position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		const below = { x: foot.x, y: foot.y - 1, z: foot.z };
		const block = driver.world.blockAt(below);
		if (!block || !block.diggable || block.name === "air") return;
		// 水や溶岩は掘っても穴にならない。流れ込むか、落ちて死ぬ。
		if (block.name === "water" || block.name === "lava") return;

		// 掘った先が空洞なら潜らない。
		//
		// 「1マス潜って蓋をする」つもりの穴が、洞窟の天井に空けた落とし穴に
		// なっていた。掘る先の下を見ていなかったため。9/5〜9/11 の死因606件の
		// うち death.fell が146件(24%)、落ちた先は暗い洞窟なので、そこで
		// さらに mob に殺されて持ち物ごと失う。潜れないなら潜らない方がよい。
		const unsafe = this.burrowHazardBelow(below);
		if (unsafe) {
			this.log(`[反射] 潜るのをやめる（${unsafe}）`);
			return;
		}

		this.log("[反射] 潜って身を隠す");
		try {
			await driver.equipBestTool(below);
			await driver.dig(signal, below);
			// 掘った穴へ落ちるのを待つ。
			await new Promise((r) => setTimeout(r, 600));
		} catch {
			return;
		}

		// 頭上に蓋をする。置ける物が無ければ潜っただけで済ませる。
		const cover = driver.inventory
			.items()
			.find((i) => i.slot >= 0 && i.slot <= 8 && PLACEABLE_COVER.some((n) => i.name.endsWith(n)));
		if (!cover) return;
		try {
			await driver.equip(cover.name, "hand");
			// 自分がいるマスの上に、その隣を支えにして置く。
			const here = driver.getState().position;
			const head = { x: Math.floor(here.x), y: Math.floor(here.y) + 1, z: Math.floor(here.z) };
			const support = { x: head.x + 1, y: head.y, z: head.z };
			if (driver.world.blockAt(support)?.solid) {
				await driver.placeBlock(signal, support, { x: -1, y: 0, z: 0 });
			}
		} catch {
			// 蓋ができなくても、潜っただけで当たりにくくはなっている。
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
			return f.name === "air" && h.name === "air";
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
				if (above && above.name !== "air" && above.diggable) {
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
