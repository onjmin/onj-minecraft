import mineflayer from "mineflayer";
import { type goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { emitDiscordWebhook } from "./discord-webhook";
import { llm } from "./llm-client";

const mcDataFactory = require("minecraft-data"); // ファクトリを読み込み

type ObservationRecord = {
	action: string;
	rationale: string;
	result: "Success" | "Fail";
	message: string;
};

export class AgentOrchestrator {
	public bot: mineflayer.Bot;
	private profile: any;
	private tools: Map<string, any>; // Store tools in a Map for easy lookup
	private currentTaskName: string = "idle";

	private observationHistory: ObservationRecord[] = [];
	private maxHistory = 5; // 少し増やして5件程度保持

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

			// パスファインダー関連のイベントは bot から取得
			// 計算が完了/中止されたとき
			this.bot.on("goal_reached", () => {
				console.log(`[${this.profile.name}] Goal reached!`);
			});

			this.bot.on("path_update", (results) => {
				// status: 'success', 'noPath', 'timeout' など
				if (results.status === "noPath") {
					console.warn(`[${this.profile.name}] No path found to destination.`);
				}
			});

			this.bot.on("path_reset", (reason) => {
				console.log(`[${this.profile.name}] Path reset: ${reason}`);
			});

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

			movements.canDig = true; // ブロックを掘って進む
			movements.allow1by1towers = true; // 足元に置いて登る
			movements.allowParkour = true; // 1ブロックの隙間を飛び越える

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
		// 起動時の初期化ログ
		console.log(`[${this.profile.name}] ReflexLoop started. Task: ${this.currentTaskName}`);

		// 起動時に 0~2秒 ランダムに待たせて、3人が同時に goto しないようにする
		await new Promise((r) => setTimeout(r, Math.random() * 2000));

		while (this.bot) {
			const tool = this.tools.get(this.currentTaskName);

			if (tool) {
				// 現在のゴールを取得
				const currentGoal = this.bot.pathfinder.goal;
				console.log(
					`[${this.profile.name}] Task: ${this.currentTaskName} | Active Goal: ${currentGoal ? "Yes" : "None"}`,
				);
				try {
					// LLMの入力は今回はないので空のオブジェクト
					// 完了するまでしっかり await する（これが重要）
					const result = await tool.handler(this, {});

					// 2. 実行結果を履歴に保存 (ここで push)
					// rationale は ThinkingLoop でセットされた latestRationale を使うと良いです
					this.pushHistory({
						action: this.currentTaskName,
						rationale: (this as any).latestRationale || "Continuing task",
						result: result.success ? "Success" : "Fail",
						message: result.message,
					});

					if (!result.success) {
						// 失敗（道がない等）した場合は少し長めに待機して負荷を避ける
						await new Promise((r) => setTimeout(r, 2000));
					}
				} catch (e) {
					// ここで「パスが見つからない」などのエラーをキャッチ
					const errorMsg = e instanceof Error ? e.message : String(e);
					console.error(`[${this.profile.name}] Reflex Error: ${errorMsg}`);

					// パスが見つからない(No path)エラー時は少し長めに待機
					if (errorMsg.includes("No path")) {
						await new Promise((r) => setTimeout(r, 2000));
					}
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
			const historyText = this.getHistoryContext();

			const systemPrompt = `You are ${this.profile.name}.
## PERSONALITY
${this.profile.personality}

## CURRENT STATUS
- HP: ${this.bot.health}
- Food: ${this.bot.food}
- Current Pos: ${this.bot.entity.position.floored()}

## PAST OBSERVATIONS (Your memory)
${historyText}

## AVAILABLE TOOLS
[${toolNames}]

## TASK
1. Review the "PAST OBSERVATIONS". If a tool failed repeatedly, DO NOT try the same parameters.
2. Decide the next tool. If the DoD gap remains, try a different approach.

## OUTPUT FORMAT
Rationale: (Briefly explain your logic based on history)
Tool: (The exact name of the tool)`;

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

	/**
	 * A* (pathfinder.goto) を実行し、失敗した場合は物理的な強制移動（フォールバック）を行います。
	 */
	public async smartGoto(goal: goals.Goal): Promise<void> {
		try {
			// A* での移動を試みる
			await Promise.race([
				this.bot.pathfinder.goto(goal),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Pathfinding timeout")), 12000),
				),
			]);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.warn(`[${this.profile.name}] A* failed (${errorMsg}). Starting physical fallback...`);

			// 1. ゴールオブジェクトから安全に座標を抽出する
			const target = goal as any; // 型チェックを回避

			// 座標を持っているタイプのゴール（GoalXZ, GoalNear, GoalBlock等）か確認
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
				console.log(`[${this.profile.name}] No coordinate in goal. Random jump fallback.`);
				this.bot.setControlState("jump", true);
				await new Promise((r) => setTimeout(r, 500));
				this.bot.clearControlStates();
			}

			console.log(`[${this.profile.name}] Fallback movement finished.`);
		}
	}
}
