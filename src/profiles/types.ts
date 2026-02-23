// エージェントのプロファイル型定義
export interface AgentProfile {
	/** マイクラのユーザー名 (ID) */
	minecraftName: string;
	/** 通知や表示で使用する日本語名 */
	displayName: string;
	/** 根源的な性格設定 (LLMへの基礎情報) */
	personality: string;
	/** なりきり（ロールプレイ）のための詳細な指示プロンプト */
	roleplayPrompt: string;
	/** スキンのテクスチャURL */
	skinUrl: string;
	/** iscordの通知アイコン用 (正方形の顔画像など) **/
	avatarUrl: string;
	/** オプション: 初期装備やスポーン地点などの追加設定 */
	metadata?: Record<string, any>;
}
