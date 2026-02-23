// スネークケース（_を含む）を禁止するためのユーティリティ型
type NoSnakeCase<T> = {
	[K in keyof T]: K extends `${string}_${string}`
		? `Snake case is not allowed: ${K & string}`
		: T[K];
};

export interface ToolField {
	type: "string" | "number" | "boolean";
	description: string;
	isRawData?: true; // STEP 2で隠蔽し、STEP 3で注入するフラグ
}

// 成功時と失敗時を型レベルで分離する
export type ToolResponse<T = void> =
	| { success: true; summary: string; data: T; error?: never }
	| { success: false; summary: string; data?: never; error: string };

export interface ToolDefinition<T, R = void> {
	name: string;
	description: string;
	inputSchema: Record<keyof T, ToolField>;
	handler: (args: T) => Promise<ToolResponse<R>>;
}

export function createTool<T extends NoSnakeCase<T>, R = void>(
	definition: ToolDefinition<T, R>,
): ToolDefinition<T, R> {
	return definition;
}

export const toolResult = {
	// R が void の場合は data を省略可能にするためのオーバーロード
	ok: <R>(summary: string, data: R): ToolResponse<R> => ({
		success: true,
		summary,
		data,
	}),
	// 戻り値データがない(void)場合のヘルパー
	okVoid: (summary: string): ToolResponse<void> => ({
		success: true,
		summary,
		data: undefined,
	}),
	// fail は data を持たず、error を必須にする。
	// R が何であっても代入可能なように ToolResponse<any> ではなく
	// Union 型の構造を利用する
	fail: (error: string): ToolResponse<never> => ({
		success: false,
		summary: `Error: ${error}`,
		error,
	}),
};
