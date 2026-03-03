import { callLlm } from "./llm-client";
import { parseLlmOutput } from "./llm-output-parser";
import { buildThinkingPrompt } from "./prompt-builder";

export interface ThinkingLoopDeps {
	getAgentState: () => any;
	applyThoughtResult: (result: ParsedThought) => Promise<void>;
	isRunning: () => boolean;
	getIntervalMs: () => number;
	log?: (msg: string) => void;
}

export interface ParsedThought {
	speak?: string;
	action?: {
		name: string;
		args?: Record<string, any>;
	};
	memory?: string;
}

export function startThinkingLoop(deps: ThinkingLoopDeps) {
	const { getAgentState, applyThoughtResult, isRunning, getIntervalMs, log } = deps;

	let aborted = false;

	async function loop() {
		while (!aborted && isRunning()) {
			try {
				const state = getAgentState();

				// 1️⃣ prompt生成
				const prompt = buildThinkingPrompt(state);

				log?.("🧠 Thinking...");

				// 2️⃣ LLM呼び出し
				const rawOutput = await callLlm(prompt);

				// 3️⃣ パース
				const parsed = parseLlmOutput(rawOutput);

				// 4️⃣ agentへ適用
				await applyThoughtResult(parsed);
			} catch (err) {
				log?.(`❌ Thinking error: ${String(err)}`);
			}

			await sleep(getIntervalMs());
		}
	}

	loop();

	return {
		stop() {
			aborted = true;
		},
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
