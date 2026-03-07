import { goals } from "mineflayer-pathfinder";
import { createSkill, type SkillResponse, skillResult } from "../types";

export const gotoCoordsSkill = createSkill<
	{ x: number; y: number; z: number },
	{ x: number; y: number; z: number }
>({
	name: "goto.coords",
	description: "Moves to specific coordinates (x, y, z). Use when you know the target location.",
	inputSchema: {
		x: { type: "number", description: "Target X coordinate" },
		y: { type: "number", description: "Target Y coordinate" },
		z: { type: "number", description: "Target Z coordinate" },
	},
	handler: async ({
		agent,
		signal,
		args,
	}): Promise<SkillResponse<{ x: number; y: number; z: number }>> => {
		const { x, y, z } = args;

		agent.log(`[goto.coords] Moving to (${x}, ${y}, ${z})`);

		try {
			const goal = new goals.GoalNear(x, y, z, 2);
			await agent.abortableGoto(signal, goal);
			return skillResult.ok(`Moved to coordinates (${x}, ${y}, ${z}).`, { x, y, z });
		} catch (err) {
			return skillResult.fail(
				`Failed to reach coordinates: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
});
