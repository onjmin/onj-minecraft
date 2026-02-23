import mineflayer from "mineflayer";
import { Movements, pathfinder } from "mineflayer-pathfinder";
import { emitDiscordWebhook } from "./discord-webhook";
import { llm } from "./llm-client";

const mcDataFactory = require("minecraft-data"); // ファクトリを読み込み

export class AgentOrchestrator {
	private bot: mineflayer.Bot;
	private profile: any;
	private tools: Map<string, any>; // Store tools in a Map for easy lookup
	private currentTaskName: string = "idle";

	constructor(profile: any, toolList: any[]) {
		this.profile = profile;
		// Convert array to Map with tool name as key
		// ツール名をキーにしたMapに変換して保持
		this.tools = new Map(toolList.map((t) => [t.name, t]));

		this.bot = mineflayer.createBot({
			host: process.env.MINECRAFT_HOST,
			port: Number(process.env.MINECRAFT_PORT),
			username: profile.name,
			auth: "offline",
		});

		this.initEvents();
	}

	private initEvents() {
		this.bot.loadPlugin(pathfinder);

		this.bot.on("spawn", () => {
			console.log(`[${this.profile.name}] Spawned!`);

			// Use only 'this.bot' for Movements constructor
			// Movements のコンストラクタには this.bot のみを渡す
			const movements = new Movements(this.bot);
			movements.canDig = true; // 道を作るために掘ることを許可
			movements.allow1by1towers = true; // 足元にブロックを置いて登るのを許可

			const mcData = mcDataFactory(this.bot.version);
			movements.scafoldingBlocks.push(mcData.blocksByName.dirt.id); // 土を足場に使う

			// If you need to customize movements with mcData,
			// it's usually handled internally or set via properties.
			this.bot.pathfinder.setMovements(movements);

			this.startReflexLoop(); // 脊髄：実行ループ
			this.startThinkingLoop(); // 大脳：思考ループ
		});
	}

	/**
	 * Spinal Loop (Reflex): Continues current autonomous task
	 * 脊髄ループ：タスクを「反復」し続ける
	 */
	private async startReflexLoop() {
		while (this.bot) {
			const tool = this.tools.get(this.currentTaskName);

			if (tool) {
				try {
					await tool.handler(this.bot, {});
				} catch (e) {
					console.error(`Reflex error [${this.profile.name}]:`, e);
				}
			} else {
				// タスクが未設定(idle)なら「探索」をデフォルトにするなどの処置
				this.currentTaskName = "world.explore";
			}

			// 反復のインターバル（短すぎると負荷、長すぎると反応が鈍る）
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	/**
	 * Cerebral Loop (Thinking): Periodically re-evaluates the situation
	 * 大脳ループ：定期的に状況を評価し、方針を更新する
	 */
	private async startThinkingLoop() {
		while (this.bot) {
			const toolNames = Array.from(this.tools.keys()).join(", ");

			const systemPrompt = `You are ${this.profile.name}, with personality: ${this.profile.personality}.
Current Status: HP:${this.bot.health}, Food:${this.bot.food}.
Available Tools: [${toolNames}].

Task: Decide your next autonomous goal.
Return your decision in this format:
Rationale: (Reason for choosing this action)
Tool: (The exact name of the tool to use)`;

			try {
				// completeAsJson ではなく通常の complete を使い、自前でパースする
				const rawContent = await llm.complete(systemPrompt);

				if (!rawContent) {
					console.warn(`[${this.profile.name}] LLM returned empty response.`);
				} else {
					// --- 提示された抽出ロジックの適用 ---

					// 1. Rationale (思考プロセス) の抽出
					const rationaleMatch = rawContent.match(/Rationale:\s*(.*)/i);
					const rationale = rationaleMatch ? rationaleMatch[1].trim() : "No reasoning provided.";

					// 2. Tool 名の抽出（正規表現とフォールバック）
					const toolLineMatch = rawContent.match(/Tool:\s*([a-zA-Z0-9._-]+)/i);
					let foundToolName = toolLineMatch ? toolLineMatch[1].trim() : null;

					// 登録済みツール名との照合
					const registeredNames = Array.from(this.tools.keys());

					if (!foundToolName || !this.tools.has(foundToolName)) {
						foundToolName =
							registeredNames.find((name) => {
								const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
								return new RegExp(`\\b${escapedName}\\b`, "i").test(rawContent);
							}) ?? null;
					}

					// 3. アクションの切り替え
					if (foundToolName && this.tools.has(foundToolName)) {
						if (this.currentTaskName !== foundToolName) {
							console.log(`[${this.profile.name}] Thought: ${rationale}`);
							console.log(
								`[${this.profile.name}] Task Switched: ${this.currentTaskName} -> ${foundToolName}`,
							);
							this.currentTaskName = foundToolName;
						}
					} else {
						console.warn(
							`[${this.profile.name}] Failed to extract a valid tool from: ${rawContent}`,
						);
					}

					// Discordへ通知 (タスク変更時、または定期生存報告として)
					// rationale と foundToolName を渡して、Discord側でリッチな表示にする
					await emitDiscordWebhook({
						username: this.profile.name,
						content: `**Action:** \`${foundToolName}\`\n**Thought:** ${rationale}`,
						avatar_url: `https://minotar.net/avatar/${this.profile.name}.png`, // スキンを表示
					});
				}
			} catch (err) {
				console.error(`[${this.profile.name}] Thinking error:`, err);
			}

			await new Promise((r) => setTimeout(r, 30000));
		}
	}
}
