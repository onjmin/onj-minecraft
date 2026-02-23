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
		// 重要: プラグインのロードはインスタンスごとに行う
		this.bot.loadPlugin(pathfinder);

		this.bot.on("spawn", () => {
			console.log(`[${this.profile.name}] Spawned!`);

			// 1. mcData を現在のボットのバージョンから生成
			const mcData = mcDataFactory(this.bot.version);

			// 2. このボット専用の Movements を生成
			const movements = new Movements(this.bot);

			// パフォーマンス向上のための設定
			movements.allowFreeMotion = true; // 障害物がない直線は計算をスキップして歩く
			movements.allowSprinting = true; // 計算コストは上がるが、移動時間を短縮して計算回数を減らす

			// pathfinder 自体の計算制限（config）
			this.bot.pathfinder.setMovements(movements);
			this.bot.pathfinder.thinkTimeout = 5000; // 計算を5秒で打ち切る
			this.bot.pathfinder.tickTimeout = 20; // 1回あたりの占有時間を短くして、他ボットに処理を回す

			// 3. このボット専用の移動設定を行う
			movements.canDig = true;
			movements.allow1by1towers = true;

			const dirt = mcData.blocksByName.dirt;
			if (dirt) {
				movements.scafoldingBlocks = [dirt.id];
			}

			// 4. このボットのパスファインダーに Movements をセット
			this.bot.pathfinder.setMovements(movements);

			this.startReflexLoop();
			this.startThinkingLoop();
		});
	}

	/**
	 * Spinal Loop (Reflex): Continues current autonomous task
	 * 脊髄ループ：タスクを「反復」し続ける
	 */
	private async startReflexLoop() {
		// 起動時に 0~2秒 ランダムに待たせて、3人が同時に goto しないようにする
		await new Promise((r) => setTimeout(r, Math.random() * 2000));

		while (this.bot) {
			const tool = this.tools.get(this.currentTaskName);

			if (tool) {
				try {
					// LLMの入力は今回はないので空のオブジェクト
					// 完了するまでしっかり await する（これが重要）
					const result = await tool.handler(this.bot, {});

					if (!result.success) {
						// 失敗（道がない等）した場合は少し長めに待機して負荷を避ける
						await new Promise((r) => setTimeout(r, 2000));
					}
				} catch (e) {
					console.error(`[${this.profile.name}] Tool execution error:`, e);
					await new Promise((r) => setTimeout(r, 5000)); // エラー時は止まる
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
