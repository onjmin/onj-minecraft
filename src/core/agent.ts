import fs from "node:fs";
import path from "node:path";
import mineflayer, { type ControlState } from "mineflayer";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { AgentProfile } from "../profiles/types";
import { exploreLandSkill } from "../skills/exploring/land";
import type { SkillResponse } from "../skills/types";
import { llm } from "./llm-client";
import { parseLlmOutput } from "./llm-output-parser";
import { createPerceptionSnapshot, type DamageInfo } from "./perception";
import { buildThinkingPrompt } from "./prompt-builder";
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
	public bot: mineflayer.Bot;
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

	private chatSimhashCache: Map<string, number[]> = new Map();
	private rationaleSimhashCache: Map<string, number[]> = new Map();

	private isReconnecting: boolean = false;
	private hasStartedLoops: boolean = false;

	private currentGoal: goals.Goal | null = null;

	private currentAbort?: AbortController;
	private currentSkillArgs: Record<string, any> = {};

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

			if (!this.hasStartedLoops) {
				this.hasStartedLoops = true;
				this.startReflexLoop();
				this.startThinkingLoop();
			}
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
		});

		this.bot.on("kicked", (reason: string, loggedIn: boolean) => {
			this.log(`Kicked from server: ${reason}, loggedIn: ${loggedIn}`);
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
		const movements = new Movements(this.bot);

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
					(e.type === "mob" || e.type === "hostile") &&
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

		this.bot.clearControlStates();
	}

	private handleEnvironmentCheck() {
		const entity = this.bot.entity;

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
					if (this.currentAbort && !this.currentAbort.signal.aborted) {
						this.currentAbort.abort();
					}

					const controller = new AbortController();
					this.currentAbort = controller;

					await this.ensureOnLand(controller.signal);

					let result: SkillResponse | undefined;

					const args = this.currentSkillArgs[skill.name] || {};

					try {
						this.log(
							`${skill.name} start${Object.keys(args).length > 0 ? ` with args: ${JSON.stringify(args)}` : ""}`,
						);
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
					this.log(`${skill.name} end`);

					if (!result) {
						this.log("result of handler is undefined");
						continue;
					}

					this.pushHistory({
						action: this.currentTaskName,
						rationale: this.latestRationale || "Continuing task",
						result: result.success ? "Success" : "Fail",
						message: result.summary,
					});
					if (!result.success) await new Promise((r) => setTimeout(r, 2000));
				} catch (e) {
					const errorMsg = e instanceof Error ? e.message : String(e);
					this.log(`Reflex Error: ${errorMsg}`);
					if (errorMsg.includes("No path")) await new Promise((r) => setTimeout(r, 2000));
				}
			} else {
				this.currentTaskName = exploreLandSkill.name;
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

		const nearbyHostiles = [];
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
		while (this.bot && this.bot.entity) {
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

			await new Promise((r) => setTimeout(r, 30000));
		}
	}

	private getAgentStateForThinking() {
		const skillsContext = Array.from(this.skills.values()).map((t) => {
			const hasArgs = t.inputSchema && Object.keys(t.inputSchema).length > 0;
			const argsInfo = hasArgs
				? Object.entries(t.inputSchema)
						.map(([k, v]) => `${k}: ${(v as any).description}`)
						.join(", ")
				: "";
			return {
				name: t.name,
				description: t.description,
				args: argsInfo,
			};
		});

		const historyText = this.getHistoryContext();
		const inventory =
			this.bot.inventory
				.items()
				.map((i) => `${i.name} x${i.count}`)
				.join(", ") || "Empty";

		const heldItem = this.bot.heldItem ? this.bot.heldItem.name : "bare_hands";

		const chatLogContext =
			this.chatHistory.map((c) => `<${c.username}> ${c.message}`).join("\n") ||
			"No recent conversations.";

		// Use perception module
		const perception = createPerceptionSnapshot(this.bot, this.lastDamageCause);

		// Nearby blocks sampling (radius 8, random 10 points)
		const sampleRadius = 8;
		const sampledBlocks: string[] = [];
		for (let i = 0; i < 10; i++) {
			const dx = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			const dy = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			const dz = Math.floor(Math.random() * sampleRadius * 2 - sampleRadius);
			const pos = this.bot.entity.position.offset(dx, dy, dz);
			const block = this.bot.blockAt(pos);
			if (block && block.name !== "air") {
				sampledBlocks.push(block.name);
			}
		}
		const nearbyBlocksText = [...new Set(sampledBlocks)].slice(0, 10).join(", ") || "None";

		return {
			profile: {
				name: this.profile.minecraftName,
				personality: this.profile.personality,
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

		const rationale = result.memory || "No reasoning.";
		const foundSkillName = result.action?.name;
		const parsedArgs = result.action?.args || {};

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
			this.bot.chat(chatMessage);
		}

		if (foundSkillName && this.skills.has(foundSkillName)) {
			this.cancelCurrentExecution();
			if (this.currentTaskName !== foundSkillName) {
				this.currentTaskName = foundSkillName;
				this.latestRationale = rationale;

				const now = Date.now();
				const isNewRationale = !isSameSimhash(
					rationale,
					`rationale:${this.profile.minecraftName}`,
					this.rationaleSimhashCache,
				);
				if (now - lastDiscordEmitAt >= 10_000 && isNewRationale) {
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

	private cancelCurrentExecution() {
		if (this.currentAbort) {
			this.currentAbort.abort("New task assigned by thinking loop");
		}

		try {
			this.bot.pathfinder.setGoal(null);
		} catch {}

		try {
			this.bot.pathfinder.stop();
		} catch {}

		try {
			this.bot.stopDigging();
		} catch {}

		for (const key of Object.keys(this.bot.controlState)) {
			this.bot.setControlState(key as any, false);
		}
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

	public getNearestBase(): {
		id: string;
		type: string;
		position: { x: number; y: number; z: number };
		safe: boolean;
		functional: boolean;
		hasStorage: boolean;
	} | null {
		if (this.bases.length === 0) return null;
		const pos = this.bot.entity.position;
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
		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}
		this.bot.setControlState(control, value);
	}

	public async abortableDig(signal: AbortSignal, block: any): Promise<void> {
		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}
		const p = new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				this.bot.stopDigging();
				reject(new Error("Aborted"));
			};

			if (signal?.aborted) {
				onAbort();
				return;
			}

			const abortHandler = () => onAbort();
			signal?.addEventListener("abort", abortHandler);

			this.bot.once("blockBreakProgressObserved", () => {
				if (this.checkAbort(signal)) {
					this.bot.stopDigging();
				}
			});

			this.bot.once("diggingCompleted", () => {
				signal?.removeEventListener("abort", abortHandler);
				resolve();
			});

			this.bot.once("diggingAborted", () => {
				signal?.removeEventListener("abort", abortHandler);
				reject(new Error("Digging aborted"));
			});

			this.bot
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
		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}

		const attackLoop = async () => {
			while (true) {
				if (this.checkAbort(signal)) {
					throw new Error("Aborted");
				}
				try {
					await this.bot.attack(target);
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
					this.bot.attack(target);
				},
				{ once: true },
			);
		}

		return attackPromise;
	}

	public async abortableGoto(signal: AbortSignal, goal: goals.Goal): Promise<void> {
		if (this.checkAbort(signal)) {
			throw new Error("Aborted");
		}

		if ((this.currentGoal as any)?.equals?.(goal)) {
			return;
		}

		this.currentGoal = goal;

		if (this.isMoving) {
			this.bot.pathfinder.stop();
			this.bot.clearControlStates();
			await new Promise((r) => setTimeout(r, 200));
		}

		this.isMoving = true;

		const startPos = this.bot.entity.position.clone();
		let lastPos = startPos.clone();
		let stuckCount = 0;
		const checkStuck = setInterval(() => {
			if (this.checkAbort(signal)) {
				clearInterval(checkStuck);
				return;
			}
			const currentPos = this.bot.entity.position;
			if (currentPos.distanceTo(lastPos) < 0.05) {
				stuckCount++;
			} else {
				stuckCount = 0;
			}
			if (stuckCount >= 2) {
				this.log(`Pathfinding: Stuck detected...`);

				const pos = this.bot.entity.position;
				const block = this.bot.blockAt(pos);
				const inWater = block?.name === "water" || (this.bot.entity as any).isInWater;

				// 1. Pathfinderを停止
				const currentGoal = this.bot.pathfinder.goal;
				this.bot.pathfinder.setGoal(null);
				this.bot.clearControlStates();

				if (inWater) {
					this.log(`Pathfinding: Force water recovery initiated...`);

					// 1. 型エラーを回避しつつターゲットを特定
					const goal: any = this.bot.pathfinder.goal;
					let targetVec = null;
					if (goal && goal.x !== undefined) {
						targetVec = new (require("vec3"))(goal.x, goal.y ?? this.bot.entity.position.y, goal.z);
					}

					// 2. 物理スタック解消シーケンス
					// 目的地を向く
					if (targetVec) this.bot.lookAt(targetVec, true);

					// 一旦、斜め後ろに下がって「角」から完全に離れる
					const side = Math.random() > 0.5 ? "left" : "right";
					this.bot.setControlState("back", true);
					this.bot.setControlState(side as any, true);

					setTimeout(() => {
						this.bot.clearControlStates();

						// 3. 勢いをつけてジャンプ・スプリントで上陸を試みる
						if (targetVec) this.bot.lookAt(targetVec, true);
						this.bot.setControlState("forward", true);
						this.bot.setControlState("jump", true);
						this.bot.setControlState("sprint", true);

						setTimeout(() => {
							this.bot.clearControlStates();
							// 4. パスファインダーをリセットして再計算を強制
							if (currentGoal) {
								this.bot.pathfinder.setGoal(null); // 一度クリア
								setTimeout(() => this.bot.pathfinder.setGoal(currentGoal), 100);
							}
						}, 1500); // 滞空・上陸時間を長めに確保
					}, 500); // 下がる時間を0.5秒に延長
				} else {
					// 【陸上リカバリ】既存の「後ろに下がって斜めジャンプ」
					this.bot.setControlState("back", true);
					setTimeout(() => {
						this.bot.setControlState("back", false);
						this.bot.setControlState("jump", true);
						this.bot.setControlState("forward", true);
						this.bot.setControlState("right", true);

						setTimeout(() => {
							this.bot.clearControlStates();
							if (currentGoal) this.bot.pathfinder.setGoal(currentGoal);
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
					await this.bot.pathfinder.goto(goal);
					this.log(`Pathfinding: Reached goal successfully!`);
					break;
				} catch (err) {
					this.log(`Pathfinding Error: ${err instanceof Error ? err.message : String(err)}`);
					this.log(`Pathfinding: Current pos after error: ${this.bot.entity.position}`);
					await new Promise((r) => setTimeout(r, 1000 * retry));
				}
				retry++;
			} while (retry < 3);
		} catch {
		} finally {
			clearInterval(checkStuck);
			this.isMoving = false;
			this.bot.clearControlStates();
		}
	}

	public async pickupNearbyItems(signal: AbortSignal): Promise<void> {
		const distance = 8;
		const getNearestItem = () => {
			return Object.values(this.bot.entities).find(
				(e) => e.name === "item" && this.bot.entity.position.distanceTo(e.position) < distance,
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

	private async ensureOnLand(signal: AbortSignal): Promise<void> {
		const { bot } = this;
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

	/**
	 * 人間の目に近づけた明るさ知覚
	 */
	private getPerceivedLight(samples = 30, radius = 4) {
		let total = 0;
		let count = 0;

		for (let i = 0; i < samples; i++) {
			const offset = new Vec3(
				(Math.random() - 0.5) * radius * 2,
				1 + Math.random(), // 目線高さ付近
				(Math.random() - 0.5) * radius * 2,
			);

			const pos = this.bot.entity.position.plus(offset);
			const block = this.bot.blockAt(pos);

			if (block) {
				const raw = Math.max(block.light, block.skyLight);
				const perceived = Math.log2(raw + 1) / Math.log2(16);
				total += perceived;
				count++;
			}
		}

		return count > 0 ? total / count : 0;
	}
}
