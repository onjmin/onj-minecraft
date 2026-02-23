import mineflayer from "mineflayer";
import { type goals, Movements, pathfinder } from "mineflayer-pathfinder";
import type { AgentProfile } from "../profiles/types";
import { emitDiscordWebhook, translateWithRoleplay } from "./discord-webhook";
import { llm } from "./llm-client";

const mcDataFactory = require("minecraft-data");

type ObservationRecord = {
	action: string;
	rationale: string;
	result: "Success" | "Fail";
	message: string;
};

export class AgentOrchestrator {
	public bot: mineflayer.Bot;
	private profile: AgentProfile;
	private tools: Map<string, any>;
	private currentTaskName: string = "idle";
	private observationHistory: ObservationRecord[] = [];
	private maxHistory = 5;
	private lastDamageCause: string = "None";
	private hasSetSkin: boolean = false; // スキン設定済みフラグ

	constructor(profile: AgentProfile, toolList: any[]) {
		this.profile = profile;
		this.tools = new Map(toolList.map((t) => [t.name, t]));

		this.bot = mineflayer.createBot({
			host: process.env.MINECRAFT_HOST,
			port: Number(process.env.MINECRAFT_PORT),
			username: profile.minecraftName,
			auth: "offline",
		});

		// インスタンス作成時に一度だけプラグインをロード
		this.bot.loadPlugin(pathfinder);

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
	}

	/**
	 * パスファインダーの初期設定
	 */
	private setupPathfinderConfig() {
		const mcData = mcDataFactory(this.bot.version);
		const movements = new Movements(this.bot);

		movements.allowFreeMotion = true;
		movements.allowSprinting = true;
		movements.canDig = true;
		movements.allow1by1towers = true;
		movements.allowParkour = true;

		const dirt = mcData.blocksByName.dirt;
		if (dirt) movements.scafoldingBlocks = [dirt.id];

		this.bot.pathfinder.setMovements(movements);
		this.bot.pathfinder.thinkTimeout = 5000;
		this.bot.pathfinder.tickTimeout = 20;
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
					(e.type === "mob" || e.type === "player") &&
					e.position.distanceTo(this.bot.entity.position) < 5,
			);
			this.lastDamageCause = attacker
				? `Attacked by ${attacker.name || attacker.type}`
				: "Taken damage from unknown source";
		}
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
			const tool = this.tools.get(this.currentTaskName);
			if (tool) {
				try {
					const result = await tool.handler(this, {});
					this.pushHistory({
						action: this.currentTaskName,
						rationale: (this as any).latestRationale || "Continuing task",
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

			// 次の行動までも少しランダム性を入れる
			await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));
		}
	}

	/**
	 * Cerebral Loop (Thinking): Periodically re-evaluates the situation
	 * 大脳ループ：定期的に状況を評価し、方針を更新する
	 */
	private async startThinkingLoop() {
		while (this.bot && this.bot.entity) {
			const toolNames = Array.from(this.tools.keys()).join(", ");
			const historyText = this.getHistoryContext();
			// --- インベントリ情報の取得 ---
			const inventory =
				this.bot.inventory
					.items()
					.map((i) => `${i.name} x${i.count}`)
					.join(", ") || "Empty";

			// 1. 周囲のエンティティ（Botの視界）
			// 今、目の前に何がいるか。これがないと、クリーパーが目の前にいても「採掘」を続けたり、村人がいても無視したりします。
			const nearbyEntities =
				Object.values(this.bot.entities)
					.filter(
						(e) => e.position.distanceTo(this.bot.entity.position) < 16 && e !== this.bot.entity,
					)
					.map(
						(e) =>
							`${e.name || e.type} (dist: ${Math.round(e.position.distanceTo(this.bot.entity.position))})`,
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

			const systemPrompt = `You are ${this.profile.minecraftName}.
## PERSONALITY
${this.profile.personality}
## CURRENT STATUS
- HP: ${this.bot.health}/20 | Food: ${this.bot.food}/20
- Last Damage Cause: ${this.lastDamageCause}
- Position: ${this.bot.entity.position.floored()} (Biome: ${biome})
- Time: ${timeOfDay} | Weather: ${isRaining ? "Raining" : "Clear"}
- Held Item: ${heldItem}
- Inventory: ${inventory}
- Nearby Entities: ${nearbyEntities}
## PAST OBSERVATIONS
${historyText}
## AVAILABLE TOOLS
[${toolNames}]
## OUTPUT FORMAT
Rationale: (logic)
Tool: (exact name)`;

			try {
				const rawContent = await llm.complete(systemPrompt);
				if (rawContent) {
					const rationaleMatch = rawContent.match(/Rationale:\s*(.*)/i);
					const rationale = rationaleMatch ? rationaleMatch[1].trim() : "No reasoning.";
					const toolLineMatch = rawContent.match(/Tool:\s*([a-zA-Z0-9._-]+)/i);
					const foundToolName = toolLineMatch ? toolLineMatch[1].trim() : null;

					if (foundToolName && this.tools.has(foundToolName)) {
						if (this.currentTaskName !== foundToolName) {
							this.currentTaskName = foundToolName;
							(this as any).latestRationale = rationale;
							const translatedText = await translateWithRoleplay(rationale, this.profile);
							await emitDiscordWebhook({
								username: this.profile.displayName,
								content: `**Action:** \`${foundToolName}\`\n**Thought:** ${translatedText}`,
								avatar_url: this.profile.avatarUrl,
							});
						}
					}
				}
			} catch (err) {
				console.error(`[${this.profile.minecraftName}] Thinking error:`, err);
			}
			await new Promise((r) => setTimeout(r, 30000));
		}
	}

	/**
	 * A* (pathfinder.goto) を実行し、失敗した場合は物理的な強制移動（フォールバック）を行います。
	 */
	public async smartGoto(goal: goals.Goal): Promise<void> {
		try {
			await Promise.race([
				this.bot.pathfinder.goto(goal),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Pathfinding timeout")), 12000),
				),
			]);
		} catch (err) {
			console.error(err);
			const target = goal as any;
			if (typeof target.x === "number" && typeof target.z === "number") {
				const targetY = typeof target.y === "number" ? target.y : this.bot.entity.position.y;
				const Vec3 = require("vec3");

				// その方向を向く
				await this.bot.lookAt(new Vec3(target.x, targetY, target.z));

				// 2. 物理フォールバック（ジャンプ前進）
				this.bot.setControlState("forward", true);
				this.bot.setControlState("jump", true);
				this.bot.setControlState("sprint", true);

				await new Promise((r) => setTimeout(r, 2000));
				this.bot.clearControlStates();
			} else {
				// 座標がないゴール（GoalFollow等）の場合は、ランダムにジャンプして詰まりを解消
				console.log(`[${this.profile.minecraftName}] No coordinate in goal. Random jump fallback.`);
				this.bot.setControlState("jump", true);
				await new Promise((r) => setTimeout(r, 500));
				this.bot.clearControlStates();
			}

			console.log(`[${this.profile.minecraftName}] Fallback movement finished.`);
		}
	}
}
