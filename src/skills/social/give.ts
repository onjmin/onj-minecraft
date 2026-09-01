import { createSkill, type SkillResponse, skillResult } from "../types";

/**
 * Social Domain: 持ち物を人に渡す。
 *
 * Minecraft にはプレイヤー同士で直接手渡すコマンドが無い（Java版・統合版とも）。
 * 相手のすぐ近くまで行って地面に落とし、拾わせるのがバニラでの唯一の方法。
 * このスキルはそれをまとめて行う。
 *
 * 「〇〇あげようか」と申し出られる人格にしても、これが無ければ口だけになる。
 * 実際にそう申し出て動けなかったのが、この機能を足すきっかけ。
 */
export const giveItemSkill = createSkill<
	{ player: string; item: string; count: number },
	{ player: string; item: string; count: number }
>({
	name: "social.give",
	description:
		"Gives an item from your inventory to a nearby player by walking to them and dropping it " +
		"so they can pick it up. There is no direct hand-off command in Minecraft; this is the only way.",
	inputSchema: {
		player: {
			type: "string",
			description: "Exact username of the nearby player to give the item to",
		},
		item: {
			type: "string",
			description: "Item name to give, e.g. wooden_sword, bread, cobblestone",
		},
		count: {
			type: "number",
			description: "How many to give (default 1)",
		},
	},
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ player: string; item: string; count: number }>> => {
		const { driver } = agent;

		const playerName = String(args?.player ?? "").trim();
		const itemName = String(args?.item ?? "").trim();
		// LLM が 0 や壊れた値を出すことがある。0 個渡すのは意味が無いので
		// 最低1個に丸める。多すぎる分は持っている数で下で丸める。
		const requested = Math.max(1, Math.floor(Number(args?.count) || 1));

		if (!playerName || !itemName) {
			return skillResult.fail("Both player and item must be specified.");
		}

		const have = driver.inventory
			.items()
			.reduce((sum, i) => (i.name === itemName ? sum + i.count : sum), 0);
		if (have === 0) {
			return skillResult.fail(`Don't have any ${itemName} to give.`);
		}

		const target = driver
			.nearbyEntities(64)
			.find((e) => e.kind === "player" && e.username === playerName);
		if (!target) {
			return skillResult.fail(`${playerName} is not nearby.`);
		}

		try {
			await driver.goto(signal, { kind: "near", position: target.position, distance: 2 });
		} catch (err) {
			// 詰め切れなくても、近ければ落とした物を拾える見込みはある。
			// 中断だけは投げ直す。
			if (signal.aborted) throw err;
			agent.log(`[social.give] ${playerName} まで詰め切れず: ${err}`);
		}

		const giveCount = Math.min(requested, have);
		try {
			await driver.dropItem(itemName, giveCount);
		} catch (err) {
			return skillResult.fail(
				`Failed to give item: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		return skillResult.ok(`Gave ${giveCount}x ${itemName} to ${playerName}.`, {
			player: playerName,
			item: itemName,
			count: giveCount,
		});
	},
});
