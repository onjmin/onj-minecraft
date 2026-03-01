import type { AgentOrchestrator } from "../core/agent";

// スネークケース（_を含む）を禁止するためのユーティリティ型
type NoSnakeCase<T> = {
	[K in keyof T]: K extends `${string}_${string}`
		? `Snake case is not allowed: ${K & string}`
		: T[K];
};

export interface SkillField {
	type: "string" | "number" | "boolean";
	description: string;
	isRawData?: true; // STEP 2で隠蔽し、STEP 3で注入するフラグ
}

// 成功時と失敗時を型レベルで分離する
export type SkillResponse<T = void> =
	| { success: true; summary: string; data: T; error?: never }
	| { success: false; summary: string; data?: never; error: string };

export interface SkillDefinition<T, R = void> {
	name: string;
	description: string;
	inputSchema: Record<keyof T, SkillField>;
	handler: ({agent, signal, args}: {agent: AgentOrchestrator, signal: AbortSignal, args: T}) => Promise<SkillResponse<R>>;
}

export function createSkill<T extends NoSnakeCase<T>, R = void>(
	definition: SkillDefinition<T, R>,
): SkillDefinition<T, R> {
	return definition;
}

export const skillResult = {
	// R が void の場合は data を省略可能にするためのオーバーロード
	ok: <R>(summary: string, data: R): SkillResponse<R> => ({
		success: true,
		summary,
		data,
	}),
	// 戻り値データがない(void)場合のヘルパー
	okVoid: (summary: string): SkillResponse<void> => ({
		success: true,
		summary,
		data: undefined,
	}),
	// fail は data を持たず、error を必須にする。
	// R が何であっても代入可能なように SkillResponse<any> ではなく
	// Union 型の構造を利用する
	fail: (error: string): SkillResponse<never> => ({
		success: false,
		summary: `Error: ${error}`,
		error,
	}),
};
