import mineflayer from "mineflayer";
import { type goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { BotStateMachine } from "mineflayer-statemachine";
import { Vec3 } from "vec3";
import type { AgentProfile } from "../profiles/types";
import { emitDiscordWebhook, translateWithRoleplay } from "./discord-webhook";
import { llm } from "./llm-client";

let lastDiscordEmitAt = 0;

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

export class AgentOrchestrator {
	public bot: mineflayer.Bot;
	private profile: AgentProfile;
	private skills: Map<string, any>;
	private currentTaskName: string = "idle";
	private observationHistory: ObservationRecord[] = [];
	private maxHistory = 5;
	private lastDamageCause: string = "None";
	private hasSetSkin: boolean = false;
	private latestRationale: string = "";
	private isInCombat: boolean = false;
	private currentSkillPromise: Promise<void> | null = null;
	private shouldStopSkill: boolean = false;
	private combatTarget: any = null;

	private chatHistory: ChatLog[] = [];
	private maxChatHistory = 10;

	constructor(profile: AgentProfile, skillList: any[]) {
		this.profile = profile;
		this.skills = new Map(skillList.map((t) => [t.name, t]));

		this.bot = mineflayer.createBot({
			host: process.env.MINECRAFT_HOST,
			port: Number(process.env.MINECRAFT_PORT),
			username: profile.minecraftName,
			auth: "offline",
		});

		// インスタンス作成時に一度だけプラグインをロード
		this.bot.loadPlugin(pathfinder);

		// constructor 内でロード
		const autoEatPlugin = require("mineflayer-auto-eat");
		const armorManagerPlugin = require("mineflayer-armor-manager");
		const pvpPlugin = require("mineflayer-pvp");
		const collectblockPlugin = require("mineflayer-collectblock");
		const toolPlugin = require("mineflayer-tool");

		const loadPlugin = (plugin: any) => {
			if (typeof plugin === "function") {
				return plugin;
			}
			if (plugin && typeof plugin.default === "function") {
				return plugin.default;
			}
			if (plugin && typeof plugin.plugin === "function") {
				return plugin.plugin;
			}
			throw new Error(`Invalid plugin: ${JSON.stringify(plugin)}`);
		};

		this.bot.loadPlugin(loadPlugin(autoEatPlugin));
		this.bot.loadPlugin(loadPlugin(armorManagerPlugin));
		this.bot.loadPlugin(loadPlugin(pvpPlugin));
		this.bot.loadPlugin(loadPlugin(collectblockPlugin));
		this.bot.loadPlugin(loadPlugin(toolPlugin));

		// 初期設定（一回だけ）
		(this.bot as any).autoEat.options.priority = "foodPoints";
		(this.bot as any).autoEat.options.bannedFood = ["rotten_flesh", "pufferfish"];

		// collectBlock設定
		(this.bot as any).collectBlock.setInventoryFilter((item: any) => {
			return item.name.includes("axe") || item.name.includes("pickaxe");
		});

		// tool設定 - 最適なツールを自動選択
		(this.bot as any).tool.setPrimaryHand();

		// PvP設定 - 敵を自動的に攻撃
		(this.bot as any).pvp?.setOptions({
			attackRange: 4,
			enemyBlacklist: [],
			halfSpeed: false,
		});

		// イベント登録
		this.initEvents();
	}

	/**
	 * イベントリスナーの初期化
	 * spawnの中で他のonを登録しないよう、すべて外出しで定義
	 */
	private initEvents() {
		// --- ログイン/スポーン関連 ---
		this.bot.once("spawn", () => {
			console.log(`[${this.profile.minecraftName}] First spawn - Initializing pathfinder`);
			this.setupPathfinderConfig();

			// ループは初回のスポーン時に一度だけ開始
			this.startReflexLoop();
			this.startThinkingLoop();
		});

		this.bot.on("spawn", () => {
			console.log(`[${this.profile.minecraftName}] Spawned/Respawned!`);
			this.applySkinOnce();
		});

		// --- 状態監視（重複登録を避けるためここで行う） ---
		this.bot.on("health", () => this.handleHealthChange());
		this.bot.on("entityHurt", (entity) => this.handleEntityHurt(entity));
		this.bot.on("move", () => this.handleEnvironmentCheck());

		// --- パスファインダー ---
		this.bot.on("goal_reached", () => console.log(`[${this.profile.minecraftName}] Goal reached!`));
		this.bot.on("path_update", (results) => {
			if (results.status === "noPath") {
				console.warn(`[${this.profile.minecraftName}] No path found.`);
			}
		});

		this.bot.on("chat", (username, message) => {
			// ログに追加
			this.chatHistory.push({
				username,
				message,
				timestamp: Date.now(),
			});

			// 履歴制限
			if (this.chatHistory.length > this.maxChatHistory) {
				this.chatHistory.shift();
			}

			console.log(`[Chat Log] ${username}: ${message}`);

			// オプション: 話しかけられたら即座に再考フェーズへ（30秒待たずに反応したい場合）
			// this.triggerThinking();
		});
	}

	/**
	 * パスファインダーの初期設定
	 */
	private setupPathfinderConfig() {
		const movements = new Movements(this.bot);

		movements.allowFreeMotion = true;
		movements.allowSprinting = true;
		movements.canDig = true;
		movements.allow1by1towers = true;
		movements.allowParkour = true;
		movements.allowFreeMotion = true;

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

		this.bot.pathfinder.setMovements(movements);
		this.bot.pathfinder.thinkTimeout = 5000;
		this.bot.pathfinder.tickTimeout = 100;
	}

	/**
	 * スキン適用処理（フラグ管理で連打を防止）
	 */
	private applySkinOnce() {
		if (this.profile.skinUrl && !this.hasSetSkin) {
			console.log(`[${this.profile.minecraftName}] Setting skin: ${this.profile.skinUrl}`);
			// スポーン直後の安定を待ってから一度だけ実行
			setTimeout(() => {
				this.bot.chat(`/skin ${this.profile.skinUrl}`);
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
		if (entity === this.bot.entity) {
			const attacker = this.bot.nearestEntity(
				(e) =>
					(e.type === "mob" || e.type === "hostile" || e.type === "player") &&
					e.position.distanceTo(this.bot.entity.position) < 16,
			);
			this.lastDamageCause = attacker
				? `Attacked by ${attacker.name || attacker.type}`
				: "Taken damage from unknown source";

			if (attacker && (attacker.type === "mob" || attacker.type === "hostile" || attacker.type === "player")) {
				this.enterCombat(attacker);
			}
		}
	}

	private enterCombat(target: any) {
		if (this.isInCombat) return;

		console.log(`[${this.profile.minecraftName}] Combat detected! Target: ${target.name || target.type}`);
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

		console.log(`[${this.profile.minecraftName}] Combat ended. Returning to skill mode.`);
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
		console.log(`[${this.profile.minecraftName}] Cancelling all tasks...`);

		this.shouldStopSkill = true;

		try {
			this.bot.pathfinder.stop();
		} catch (e) {}

		try {
			(this.bot as any).collectBlock.stop();
		} catch (e) {}

		try {
			(this.bot as any).pvp?.stop();
		} catch (e) {}

		this.bot.clearControlStates();
	}

	private handleEnvironmentCheck() {
		const entity = this.bot.entity;

		// 落下判定
		if (!entity.onGround && entity.velocity.y < -0.6) {
			this.lastDamageCause = "Falling";
		}

		// 環境判定
		const blockAtFeet = this.bot.blockAt(entity.position);
		if (blockAtFeet) {
			if (blockAtFeet.name === "lava") this.lastDamageCause = "Burning in Lava";
			else if (blockAtFeet.name === "fire") this.lastDamageCause = "Burning in Fire";
		}

		// 窒息判定
		const oxygen = (this.bot as any).oxygenLevel;
		if (oxygen !== undefined && oxygen <= 0) {
			this.lastDamageCause = "Drowning/Suffocating";
		}
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
		console.log(`[${this.profile.minecraftName}] ReflexLoop started.`);
		await new Promise((r) => setTimeout(r, Math.random() * 2000));

		while (this.bot && this.bot.entity) {
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
					const result = await skill.handler(this, {});
					this.pushHistory({
						action: this.currentTaskName,
						rationale: this.latestRationale || "Continuing task",
						result: result.success ? "Success" : "Fail",
						message: result.message,
					});
					if (!result.success) await new Promise((r) => setTimeout(r, 2000));
				} catch (e) {
					const errorMsg = e instanceof Error ? e.message : String(e);
					console.error(`[${this.profile.minecraftName}] Reflex Error: ${errorMsg}`);
					if (errorMsg.includes("No path")) await new Promise((r) => setTimeout(r, 2000));
				}
			} else {
				this.currentTaskName = "exploring.exploreLand";
			}

			await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
		}
	}

	private async checkCombatStatus() {
		const pvpBot = this.bot as any;

		if (pvpBot.pvp?.target) {
			this.isInCombat = true;
			return;
		}

		const nearbyHostiles = Object.values(this.bot.entities).filter(
			(e) =>
				(e.type === "mob" || e.type === "hostile") &&
				e.position.distanceTo(this.bot.entity.position) < 16,
		);

		if (nearbyHostiles.length > 0) {
			this.enterCombat(nearbyHostiles[0]);
			return;
		}

		if (this.isInCombat) {
			this.exitCombat();
		}
	}

	/**
	 * Cerebral Loop (Thinking): Periodically re-evaluates the situation
	 * 大脳ループ：定期的に状況を評価し、方針を更新する
	 */
	private async startThinkingLoop() {
		while (this.bot && this.bot.entity) {
			const skillsContext = Array.from(this.skills.values())
				.map((t) => `- ${t.name}: ${t.description}`)
				.join("\n");

			const historyText = this.getHistoryContext();
			// --- インベントリ情報の取得 ---
			const inventory =
				this.bot.inventory
					.items()
					.map((i) => `${i.name} x${i.count}`)
					.join(", ") || "Empty";

			// 1. 周囲のプレイヤー情報を詳細に取得
			const players = Object.values(this.bot.entities)
				.filter((e) => e.type === "player" && e !== this.bot.entity)
				.filter((e) => e.position.distanceTo(this.bot.entity.position) < 24); // 視界を少し広めに設定

			const nearbyPlayersData = players.map((p) => {
				const dist = Math.round(p.position.distanceTo(this.bot.entity.position));
				// 手に持っているアイテム（メインハンド）
				const heldItem = p.heldItem ? p.heldItem.name : "Nothing";
				// 装備（ヘルメット等があるか）
				const hasArmor = p.equipment?.some((item) => item && item.name.includes("helmet"))
					? "Armored"
					: "No Armor";

				return `${p.username} (Dist: ${dist}m, Holding: ${heldItem}, ${hasArmor})`;
			});

			const nearbyPlayersText =
				nearbyPlayersData.length > 0 ? nearbyPlayersData.join(", ") : "None";

			// 2. その他のエンティティ（中立・敵対モブ）
			const nearbyMobs =
				Object.values(this.bot.entities)
					.filter(
						(e) =>
							(e.type === "mob" || e.type === "hostile") &&
							e.position.distanceTo(this.bot.entity.position) < 16,
					)
					.map(
						(e) =>
							`${e.name || e.type}(${Math.round(e.position.distanceTo(this.bot.entity.position))}m)`,
					)
					.join(", ") || "None";

			// 2. 現在のバイオームと周囲の環境
			// 「砂漠で農業しようとしている」「洞窟の中にいるのに地上探索しようとしている」といった矛盾を防げます。また、**「今何時か（夜か昼か）」**は生存戦略に直結します。
			const biome = this.bot.blockAt(this.bot.entity.position)?.biome.name || "unknown";
			const isRaining = this.bot.isRaining;
			const timeOfDay = this.bot.time.isDay ? "Day" : "Night";
			// 3. 直近のダメージ原因
			// 「なぜHPが減ったか」がわからないと、同じミスを繰り返します。

			// 4. 装備の状態（Equipment）
			// 手に何を持っているか、防具を着ているか。インベントリの中にあるだけでは使えないため、**「今、手に持っているもの」**は重要です。
			const heldItem = this.bot.heldItem ? this.bot.heldItem.name : "Bare hands";

			// チャットログのテキスト化
			const chatLogContext =
				this.chatHistory.map((c) => `<${c.username}> ${c.message}`).join("\n") ||
				"No recent conversations.";

			const systemPrompt = `Your name is ${this.profile.minecraftName}.
Roleplay as this character and interact with other players naturally.

## PERSONALITY
${this.profile.personality}

## CURRENT STATUS
- HP: ${this.bot.health}/20 | Food: ${this.bot.food}/20
- Position: ${this.bot.entity.position.floored()} (Biome: ${biome})
- Time: ${timeOfDay} | Weather: ${isRaining ? "Raining" : "Clear"}
- Held Item: ${heldItem}
- Inventory: ${inventory}
- Nearby Players (IMPORTANT): ${nearbyPlayersText}
- Nearby Mobs: ${nearbyMobs}
- Last Damage Cause: ${this.lastDamageCause}

## RECENT CHAT LOG
${chatLogContext}

## PAST OBSERVATIONS
${historyText}

## AVAILABLE SKILLS
${skillsContext}

## OUTPUT FORMAT
Rationale: (logic)
Chat: (message to send in Minecraft, if any. empty if silent)
Skill: (exact name)`;

			try {
				const rawContent = await llm.complete(systemPrompt);
				if (rawContent) {
					// 1. 各セクションを抽出（次のキーワードまたは終端まで）
					const rationaleMatch = rawContent.match(
						/Rationale:\s*([\s\S]*?)(?=\n(?:Chat|Skill):|$)/i,
					);
					const chatMatch = rawContent.match(/Chat:\s*([\s\S]*?)(?=\n(?:Rationale|Skill):|$)/i);
					const skillMatch = rawContent.match(/Skill:\s*([a-zA-Z0-9._-]+)/i);

					const rationale = rationaleMatch ? rationaleMatch[1].trim() : "No reasoning.";
					let chatMessage = chatMatch ? chatMatch[1].trim() : "";
					const foundSkillName = skillMatch ? skillMatch[1].trim() : null;

					// 2. Chat内容の高度なクリーンアップ
					if (chatMessage) {
						// 1. キーワード混入対策: "Skill:" や "Rationale:" 以降をカット
						chatMessage = chatMessage.split(/(?:Skill|Rationale):/i)[0].trim();

						// 2. 複数行対策: 最初の1行目のみ取得
						chatMessage = chatMessage.split("\n")[0].trim();

						// 3. 【追加】括弧（全角含む）で始まっていたら「心の声」とみなして無視
						if (chatMessage.startsWith("(") || chatMessage.startsWith("（")) {
							chatMessage = "";
						}

						if (chatMessage) {
							// 4. 引用符の除去（"Hello" -> Hello）
							chatMessage = chatMessage.replace(/^["'「“](.*)["'」”]$/, "$1").trim();

							// 5. 特定キーワード（none, empty等）の最終判定
							const normalizedChat = chatMessage
								.toLowerCase()
								.replace(/[()."']/g, "")
								.split(/[\s—-]/)[0];

							const isNone = ["", "none", "empty", "n/a", "nothing", "silent", "ignored"].includes(
								normalizedChat,
							);

							if (isNone) {
								chatMessage = "";
							}
						}
					}

					// 最終チェック: 前後を trim した際に残った引用符をもう一度掃除
					chatMessage = chatMessage.replace(/^["'“]|["'”]$/g, "").trim();

					// 3. チャットの実行
					if (chatMessage !== "") {
						// ゲーム内チャットに送信
						this.bot.chat(chatMessage);
					}

					// --- ツールの実行とDiscord通知(思考) ---
					if (foundSkillName && this.skills.has(foundSkillName)) {
						if (this.currentTaskName !== foundSkillName) {
							this.currentTaskName = foundSkillName;
							this.latestRationale = rationale;

							console.log(
								new Intl.DateTimeFormat("ja-JP", {
									hour: "2-digit",
									minute: "2-digit",
									second: "2-digit",
									hour12: false,
									timeZone: "Asia/Tokyo",
								}).format(new Date()),
								this.profile.displayName,
								foundSkillName,
								rationale,
							);

							// --- 送信処理の中 ---
							const now = Date.now();
							if (now - lastDiscordEmitAt >= 10_000) {
								// 最後に送信した時刻を更新
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
			} catch (err) {
				console.error(`[${this.profile.minecraftName}] Thinking error:`, err);
			}
			await new Promise((r) => setTimeout(r, 30000));
		}
	}

	private isMoving: boolean = false;

	/**
	 * 強化版 smartGoto: パスファインディングと動的な物理リカバリを組み合わせます。
	 */
	public async smartGoto(goal: goals.Goal): Promise<void> {
		if (this.isMoving) {
			this.bot.pathfinder.stop();
			await new Promise((r) => setTimeout(r, 100));
		}

		this.isMoving = true;
		const maxRetries = 2; // パスが見つからない場合の再試行回数

		try {
			for (let i = 0; i <= maxRetries; i++) {
				try {
					// 1. 通常のパスファインディング実行
					await Promise.race([
						this.bot.pathfinder.goto(goal),
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error("Pathfinding timeout")), 15000),
						),
					]);
					return; // 成功すれば終了
				} catch (err) {
					if (err instanceof Error && err.name === "GoalChanged") return;

					// 2. 失敗時のリカバリ：少し後ろに下がってからジャンプ
					// 詰まっている可能性が高いため、一度リセットをかける
					console.log(
						`[${this.profile.minecraftName}] Path stuck. Attempting recovery step ${i + 1}...`,
					);

					this.bot.clearControlStates();
					// 少し後ろに下がる（空間を作る）
					this.bot.setControlState("back", true);
					await new Promise((r) => setTimeout(r, 500));
					this.bot.setControlState("back", false);

					// ターゲットの方向を向いてジャンプ
					const target = goal as any;
					if (target.x !== undefined) {
						await this.bot.lookAt(new Vec3(target.x, this.bot.entity.position.y, target.z));
						this.bot.setControlState("jump", true);
						this.bot.setControlState("forward", true);
						this.bot.setControlState("sprint", true);
						await new Promise((r) => setTimeout(r, 800));
						this.bot.clearControlStates();
					}

					// 再試行ループへ
				}
			}
		} finally {
			this.isMoving = false;
			this.bot.clearControlStates();
		}
	}
}
