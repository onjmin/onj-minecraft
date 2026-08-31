import fs from "node:fs";
import path from "node:path";
import mineflayer, { type ControlState } from "mineflayer";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import type { AgentProfile } from "../profiles/types";
import { exploreLandSkill } from "../skills/exploring/land";
import { gotoDeathPointSkill } from "../skills/goto/death";
import { gotoSurfaceSkill } from "../skills/goto/surface";
import type { SkillResponse } from "../skills/types";
import { JavaDriver } from "./driver/java";
import type { BotDriver, Position } from "./driver/types";
import { llm } from "./llm-client";
import { parseLlmOutput } from "./llm-output-parser";
import { createPerceptionSnapshot, type DamageInfo } from "./perception";
import { buildThinkingPrompt } from "./prompt-builder";
import type { SafeBot } from "./types";
import { emitDiscordWebhook, translateWithRoleplay } from "./utils/discord-webhook";
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
const MAX_UNINTERRUPTED_MS = Number(process.env.SKILL_MAX_RUN_MS ?? 300_000);

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
const MIN_UNINTERRUPTED_MS = Number(process.env.SKILL_MIN_RUN_MS ?? 60_000);

/** これを下回ったら戦わずに逃げる。 */
const FLEE_HEALTH = Number(process.env.FLEE_HEALTH ?? 10);
/** 死亡地点の落とし物を追いかける制限時間。落下物は5分ほどで消える。 */
const DEATH_LOOT_WINDOW_MS = Number(process.env.DEATH_LOOT_WINDOW_MS ?? 240_000);
/** 一度の反射で振る回数。振り続けて本来の行動を止めない程度に。 */
const ATTACK_SWINGS = 4;
/** 頭上の蓋に使える物。何でもよいが、貴重な物を使わないよう絞る。 */
const PLACEABLE_COVER = ["dirt", "cobblestone", "stone", "_planks", "gravel", "sand", "netherrack"];
/** 防具かどうかの判定に使う。 */
const ARMOR_SUFFIXES = ["_helmet", "_chestplate", "_leggings", "_boots"];
/** この体力を下回ったら、昼でも潜って回復を待つ。 */
const SHELTER_HEALTH = Number(process.env.SHELTER_HEALTH ?? 8);
/** 埋まっているかを見る高さ。屋根はこの範囲に収まる前提。 */
const BURIED_SCAN_HEIGHT = 32;
/** これだけ続けて一瞬で終わったら、乗り換えの猶予を外す。 */
const SPIN_LIMIT = Number(process.env.SKILL_SPIN_LIMIT ?? 3);

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

function distanceTo(
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

type ChatLog = {
	username: string;
	message: string;
	timestamp: number;
};

type StrategicState = {
	strategies: string[]; // FIFO 3
	achievements: string[]; // FIFO 3
	chats: string[]; // FIFO 3 (自分自身の過去発言)
};

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

	private chatHistory: ChatLog[] = [];
	private maxChatHistory = 3;
	/** 他プレイヤーの発言を最後に受け取った時刻。0 は未受信。 */
	private lastHeardAt = 0;
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
	/**
	 * 死んだ場所と時刻。持ち物はそこに落ちているので、取りに戻る手掛かり。
	 * 落下物は5分ほどで消えるため、古くなったら捨てる。
	 */
	private deathPoint: { position: Position; at: number } | null = null;
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
		this.skills = new Map(skillList.map((t) => [t.name, t]));

		if (injectedDriver) {
			this.isJava = false;
			this.driver = injectedDriver;
			// 他プレイヤーとの意思疎通のため、発言の受信だけは共通で購読する
			this.driver.on("chat", (username: string, message: string) =>
				this.handleIncomingChat(username, message),
			);
			// 死んだ場所を控える。持ち物は全部そこに落ちている。
			this.driver.on("death", () => {
				this.deathPoint = { position: { ...this.driver.getState().position }, at: Date.now() };
				this.log(
					`死亡地点を記録: (${this.deathPoint.position.x.toFixed(0)}, ${this.deathPoint.position.y.toFixed(0)}, ${this.deathPoint.position.z.toFixed(0)})`,
				);
			});
			// 復帰したら、まず落とし物を取りに行かせる。放っておくと消える。
			this.driver.on("respawn", () => {
				if (!this.deathPoint) return;
				this.currentTaskName = gotoDeathPointSkill.name;
				this.currentTaskSince = Date.now();
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

		this.chatHistory.push({ username, message, timestamp: Date.now() });
		if (this.chatHistory.length > this.maxChatHistory) {
			this.chatHistory.shift();
		}
		this.lastHeardAt = Date.now();
		this.log(`<${username}> ${message}`);
		// 人の話は次の判断まで30秒待たせない。指示なら尚更で、
		// 待たせると「聞こえていない」ようにしか見えない。
		this.humanRequestPending = true;
		this.requestImmediateThink();
	}

	/** 思考ループの待ちを切り上げて、すぐ考え直させる。 */
	private requestImmediateThink(): void {
		const wake = this.wakeThinking;
		this.wakeThinking = null;
		if (wake) wake();
	}

	/** 直近に話しかけられているか。発言してよいかの判断に使う。 */
	private wasSpokenToRecently(withinMs = 90_000): boolean {
		return this.lastHeardAt > 0 && Date.now() - this.lastHeardAt < withinMs;
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

	/** 死んだ場所。取りに行く価値があるうちだけ返す。 */
	public getDeathPoint(): Position | null {
		if (!this.deathPoint) return null;
		if (Date.now() - this.deathPoint.at > DEATH_LOOT_WINDOW_MS) {
			// 落下物はもう消えている。追いかけるだけ無駄。
			this.deathPoint = null;
			return null;
		}
		return this.deathPoint.position;
	}

	public clearDeathPoint(): void {
		this.deathPoint = null;
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
					await this.reflexSurvival(controller.signal);

					let result: SkillResponse | undefined;

					const args = this.currentSkillArgs[skill.name] || {};
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
					}
					// 終わったものを「長く走っている」と誤判定しないよう戻す。
					this.currentExecutionStartedAt = 0;
					this.log(`${skill.name} end`);

					if (!result) {
						this.log("result of handler is undefined");
						continue;
					}

					this.recordSkillOutcome(skill.name, result.success);
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
			} catch (err) {
				this.log(`Thinking error: ${err}`);
			}

			// 途中で起こされたら待たずに次を考える。
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.wakeThinking = null;
					resolve();
				}, 30000);
				this.wakeThinking = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
	}

	private getAgentStateForThinking() {
		const skillsContext = Array.from(this.skills.values())
			// 落とし物の回収は、落とし物があるときだけ見せる。無いときに見せると
			// LLM が選んで即失敗する。実測で15分に20回選ばれ、そのぶん他の
			// 行動が選ばれなかった。これは反射で扱うもので、判断の対象ではない。
			.filter((t) => t.name !== gotoDeathPointSkill.name || this.getDeathPoint() !== null)
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

		const chatLogContext =
			this.chatHistory.map((c) => `<${c.username}> ${c.message}`).join("\n") ||
			"No recent conversations.";

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
					roleplay: this.profile.roleplayPrompt,
					chatLanguage: this.profile.chatLanguage,
				},
				environment: {
					biome: "unknown",
					timeOfDay: "day",
					weather: "clear",
					lightLevel: 0,
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
				chatHistory: [chatLogContext],
				awaitingReply: this.wasSpokenToRecently(),
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
				roleplay: this.profile.roleplayPrompt,
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
			skills: skillsContext,
			chatHistory: [chatLogContext],
			awaitingReply: this.wasSpokenToRecently(),
			lastDamageCause: this.lastDamageCause,
			memorySummary: historyText,
		};
	}

	private async applyThoughtResult(result: any) {
		// Extract strategy and achievement from memory
		const memoryText = result.memory || "";
		const strategyMatch = memoryText.match(/Strategy:\s*(.+?)(?:\||$)/);
		const achievementMatch = memoryText.match(/Achievement:\s*(.+?)(?:\||$)/);

		if (strategyMatch) {
			this.updateFIFO(this.strategicState.strategies, strategyMatch[1].trim());
		}
		if (achievementMatch) {
			this.updateFIFO(this.strategicState.achievements, achievementMatch[1].trim());
		}

		// この判断で使い切る。次の周からは通常の猶予に戻す。
		const wasHumanRequest = this.humanRequestPending;
		this.humanRequestPending = false;
		void wasHumanRequest;

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

		const chatMessage = result.speak || "";
		const isNewChat = !isSameSimhash(
			chatMessage,
			this.profile.minecraftName,
			this.chatSimhashCache,
		);
		if (isNewChat && chatMessage && this.updateFIFO(this.strategicState.chats, chatMessage)) {
			// 自分の計画を一方的に垂れ流すのはやめ、話しかけられたときの返答に限る。
			// エージェントが1体だけの環境では独り言は誰にも届かず、
			// 同居している他プレイヤーにとってはノイズにしかならないため。
			// ENABLE_CHAT=1 にすると従来通り常に発言する（複数体で会話させる場合）。
			if (process.env.ENABLE_CHAT === "1" || this.wasSpokenToRecently()) {
				this.driver.chat(chatMessage);
			} else {
				this.log(`(独り言のため発言せず: ${chatMessage})`);
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
			const spinning = this.instantRepeats >= SPIN_LIMIT;
			const tooEarlyToSwitch =
				!isSameTask &&
				!this.humanRequestPending &&
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

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					bot.attack(target);
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
	private async reflexSurvival(signal: AbortSignal): Promise<void> {
		try {
			await this.recoverDeathLootIfAlive();
			this.returnToSurfaceIfBuried();
			await this.wearBestArmor();
			if (await this.shelterAtNight(signal)) return;
			await this.escapeIfBoxedIn(signal);
		} catch (e) {
			// 反射行動で本来の行動を止めない。
			if (!signal.aborted) this.log(`反射行動でつまずいた: ${e}`);
		}
	}

	/**
	 * 生き返っていて落とし物が残っているなら、取りに行く手配をする。
	 *
	 * サーバーが復帰の通知を返さないことがあるので、イベントに頼らず
	 * 「死亡地点を控えている・体力がある」で判断する。
	 */
	private async recoverDeathLootIfAlive(): Promise<void> {
		if (!this.getDeathPoint()) return;
		if (this.driver.getState().health <= 0) return;
		if (this.currentTaskName === gotoDeathPointSkill.name) return;
		if (!this.skills.has(gotoDeathPointSkill.name)) return;
		this.log("[反射] 落とし物を取りに戻る");
		this.currentTaskName = gotoDeathPointSkill.name;
		this.currentTaskSince = Date.now();
		this.instantRepeats = 0;
	}

	/**
	 * 地下に埋まっているなら、地上へ戻ることを最優先にする。
	 *
	 * 木も動物も地上にある。地下で探索や狩りを繰り返しても永久に何も得られ
	 * ない。実測で Y=34 に落ちたまま10分間、exploring.explore_land 63回と
	 * collecting.hunting 23回を空振りし続けた。どちらもその場では成立しない。
	 *
	 * これは判断ではなく前提条件なので、LLM に選ばせない。ただし採集中は
	 * 邪魔しない。地下を掘っているのは正しい行動でありうる。
	 */
	private returnToSurfaceIfBuried(): void {
		if (!this.skills.has(gotoSurfaceSkill.name)) return;
		if (this.currentTaskName === gotoSurfaceSkill.name) return;
		// 採集や設置の最中は割り込まない。地下にいるのが目的のことがある。
		if (this.currentTaskName.startsWith("collecting.")) return;
		if (this.currentTaskName.startsWith("building.")) return;

		const state = this.driver.getState();
		const foot = {
			x: Math.floor(state.position.x),
			y: Math.floor(state.position.y),
			z: Math.floor(state.position.z),
		};
		// 頭上に空気以外があれば屋根の下。goto.surface と同じ見方をする。
		let buried = false;
		for (let y = foot.y + 2; y <= foot.y + 2 + BURIED_SCAN_HEIGHT; y++) {
			const above = this.driver.world.blockAt({ x: foot.x, y, z: foot.z });
			if (above === null) break;
			if (above.name !== "air") {
				buried = true;
				break;
			}
		}
		if (!buried) return;

		this.log("[反射] 地下に埋まっている。地上へ戻る");
		this.currentTaskName = gotoSurfaceSkill.name;
		this.currentTaskSince = Date.now();
		this.instantRepeats = 0;
	}

	/**
	 * 夜、丸腰なら潜ってやり過ごす。
	 *
	 * 8分で13回死に、大半が death.attack.mob だった。復帰しては即座に殺され、
	 * 集めた物も作った道具もその都度消える。武器も防具も無いうちに夜の地上を
	 * 歩き回るのは、進むどころか積み上げたものを失う行為でしかない。
	 *
	 * 逃走と反撃はサイドカーが毎tick行うが、あれは目の前の敵をしのぐだけで、
	 * 夜通し追われ続ける状況は変えられない。こちらは「そもそも出歩かない」
	 * 判断で、頻度も低いのでこの層でよい。
	 *
	 * 戻り値が true なら、この周の他の反射は行わない。
	 */
	private async shelterAtNight(signal: AbortSignal): Promise<boolean> {
		const state = this.driver.getState();
		// 死んでいる間は何もしない。復帰の要求はサイドカーが出している。
		if (state.health <= 0) return false;

		const night = state.timeOfDay >= 13000 && state.timeOfDay <= 23000;
		// 傷ついていて、しかも敵が近いときだけ退く。体力だけで判断すると、
		// 回復しないまま延々と潜り直して何も進まなくなる。実測で HP1 のまま
		// 18回潜っていた。潜っても満腹度が足りなければ回復しない。
		const hurt =
			state.health <= SHELTER_HEALTH &&
			this.driver.nearbyEntities(12).some((e) => isHostileMob(e.name));
		if (!night && !hurt) return false;

		const armed = this.hasWeapon();
		const armored = this.driver.inventory
			.items()
			.some((i) => ARMOR_SUFFIXES.some((suf) => i.name.endsWith(suf)));
		// 傷ついているときは装備の有無に関わらず退く。
		if (!hurt && (armed || armored)) return false;

		// 既に囲まれている(＝潜れている)なら、そのまま待つ。
		const pos = state.position;
		const foot = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
		const above = this.driver.world.blockAt({ ...foot, y: foot.y + 2 });
		if (above && above.name !== "air") return true;

		this.log(
			hurt ? `[反射] 体力 ${state.health}。潜って回復を待つ` : "[反射] 夜で丸腰。潜ってやり過ごす",
		);
		await this.burrow(signal);
		return true;
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

	/** 殴れる物を持っているか。素手で敵に向かうのは逃げるより悪い。 */
	private hasWeapon(): boolean {
		return this.driver.inventory
			.items()
			.some((i) => i.name.endsWith("_sword") || i.name.endsWith("_axe"));
	}

	/** 持っている中で一番良い防具を着る。既に着ているものは触らない。 */
	private async wearBestArmor(): Promise<void> {
		const ranks = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
		const slots: [string, string][] = [
			["_helmet", "head"],
			["_chestplate", "torso"],
			["_leggings", "legs"],
			["_boots", "feet"],
		];
		const items = this.driver.inventory.items();
		for (const [suffix, destination] of slots) {
			const owned = items
				.filter((i) => i.name.endsWith(suffix))
				.sort((a, b) => {
					const ra = ranks.findIndex((m) => a.name.startsWith(m));
					const rb = ranks.findIndex((m) => b.name.startsWith(m));
					return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
				});
			const best = owned[0];
			// 着けたものは持ち物から消えるので、次の周では候補に挙がらない。
			// 同じものを何度も着せ直す心配は要らない。
			if (best) await this.driver.equip(best.name, destination as any);
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

		// 全方向が塞がっている。壊せるものを1つ選んで抜ける。
		for (const d of dirs) {
			const target = { x: foot.x + d.x, y: foot.y, z: foot.z + d.z };
			const block = driver.world.blockAt(target);
			if (!block || !block.diggable) continue;
			this.log(`[反射] 四方を塞がれているので ${block.name} を掘って出る`);
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
