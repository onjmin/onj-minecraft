import { goals } from "mineflayer-pathfinder";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const gotoPlayerSkill = createSkill<void, { target: string; distance: number }>({
	name: "goto.player",
	description:
		"Moves towards the nearest player in the world. Useful for grouping up or following other players.",
	inputSchema: {} as any,
	handler: async ({
		agent,
		signal,
	}): Promise<SkillResponse<{ target: string; distance: number }>> => {
		const { bot } = agent;

		const players = Object.values(bot.players);
		const botPos = bot.entity.position;

		if (players.length === 0) {
			return skillResult.fail("No other players found nearby.");
		}

		let nearest = null;
		let minDist = Infinity;

		for (const player of players) {
			if (!player.entity) continue;
			const dist = botPos.distanceTo(player.entity.position);
			if (dist < minDist) {
				minDist = dist;
				nearest = player;
			}
		}

		if (!nearest || !nearest.entity) {
			return skillResult.fail("Could not find nearest player entity.");
		}

		const targetPos = nearest.entity.position;
		agent.log(`[goto.player] Target: ${nearest.username} at distance ${minDist.toFixed(1)}`);

		try {
			const goal = new goals.GoalNear(
				Math.floor(targetPos.x),
				Math.floor(targetPos.y),
				Math.floor(targetPos.z),
				2,
			);
			await agent.abortableGoto(signal, goal);
			return skillResult.ok(`Moved to player ${nearest.username}.`, {
				target: nearest.username,
				distance: Math.floor(minDist),
			});
		} catch (err) {
			return skillResult.fail(
				`Failed to reach player: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
