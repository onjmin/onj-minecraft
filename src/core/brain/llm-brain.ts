/**
 * 言葉で考える脳。状況を文章にして LLM に渡し、返ってきた文からスキルを読む。
 *
 * 2026-10-01 に agent.ts の思考ループから切り出した。プロンプトも解釈も
 * 動かしていない。
 */
import fs from "node:fs";
import path from "node:path";
import { llm } from "../llm-client";
import { parseLlmOutput } from "../llm-output-parser";
import { buildThinkingPrompt } from "../prompt-builder";
import { envNum } from "../utils/env";
import type { Brain, BrainInput, Decision } from "./types";

/**
 * 起こされても空ける最短間隔。
 *
 * スキルの失敗や反射の手放しで即座に考え直す仕組みにしたので、
 * 3秒おきに失敗する行動があると、そのたびに LLM を叩くことになる。
 * ローカルの 24B は1回に5〜8秒かかる。
 */
const THINK_MIN_GAP_MS = envNum("THINK_MIN_GAP_MS", 10_000);

export class LlmBrain implements Brain {
	readonly name = "llm";
	readonly periodMs = 30_000;
	readonly minGapMs = THINK_MIN_GAP_MS;

	/** @param logName 入出力を残すフォルダ名(logs/<logName>/)。 */
	constructor(private readonly logName: string) {}

	async think(input: BrainInput): Promise<Decision> {
		const state = await input.thinkingState();
		const prompt = buildThinkingPrompt(state);

		input.log("🧠 Thinking...");

		const rawOutput = await llm.complete(prompt);

		// 直近の1回分だけ残す。何を見せて何が返ったかを後から読むため。
		const logDir = path.join(process.cwd(), "logs", path.basename(this.logName));
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, "input.md"), prompt);
		fs.writeFileSync(path.join(logDir, "output.md"), rawOutput || "");

		return parseLlmOutput(rawOutput);
	}
}
