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
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const botPos = state.position;

		// 自分自身を除外したプレイヤーのみを対象にする
		const players = driver
			.nearbyEntities(128)
			.filter(
				(e): e is typeof e & { username: string } =>
					e.kind === "player" && Boolean(e.username) && e.username !== state.username,
			);

		if (players.length === 0) {
			return skillResult.fail("No other players found nearby.");
		}

		let nearest = null;
		let minDist = Infinity;

		for (const player of players) {
			const dist = Math.hypot(
				player.position.x - botPos.x,
				player.position.y - botPos.y,
				player.position.z - botPos.z,
			);
			if (dist < minDist) {
				minDist = dist;
				nearest = player;
			}
		}

		if (!nearest) {
			return skillResult.fail("Could not find nearest player entity.");
		}

		const targetPos = nearest.position;
		agent.log(`[goto.player] Target: ${nearest.username} at distance ${minDist.toFixed(1)}`);

		try {
			await driver.goto(signal, {
				kind: "near",
				position: {
					x: Math.floor(targetPos.x),
					y: Math.floor(targetPos.y),
					z: Math.floor(targetPos.z),
				},
				distance: 2,
			});
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
