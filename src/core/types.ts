import type { Bot as MineflayerBot } from "mineflayer";

// 1. 元の Bot 型から entity プロパティを除外し、新たに定義し直す
export type SafeBot = Omit<MineflayerBot, "entity"> & {
	entity: MineflayerBot["entity"] | undefined;
};
