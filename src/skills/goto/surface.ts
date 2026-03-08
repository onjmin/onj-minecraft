import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { createSkill, type SkillResponse, skillResult } from "../types";

const SAFE_BLOCKS = [
	"dirt",
	"grass_block",
	"stone",
	"cobblestone",
	"granite",
	"diorite",
	"andesite",
	"deepslate",
	"bedrock",
	"sand",
	"gravel",
];

function isSafeBlock(name: string): boolean {
	return (
		SAFE_BLOCKS.includes(name) ||
		name.endsWith("_ore") ||
		name.endsWith("_log") ||
		name.endsWith("_wood")
	);
}

function isTransparent(name: string): boolean {
	return !name || name === "air" || name === "water" || name === "lava";
}

export const gotoSurfaceSkill = createSkill<void, { y: number; method: string }>({
	name: "goto.surface",
	description:
		"Moves up to reach the surface. Efficiently samples nearby ground levels. Falls back to digging straight up if no path is found.",
	inputSchema: {} as any,
	handler: async ({ agent, signal }): Promise<SkillResponse<{ y: number; method: string }>> => {
		const { bot } = agent;
		if (!bot.entity) return skillResult.fail("Bot entity not loaded");
		const currentPos = bot.entity.position.clone();
		const startY = Math.floor(currentPos.y);

		agent.log(`[goto.surface] Current Y: ${startY}, searching for surface...`);

		const radii = [16, 8, 4];
		let targetPos: Vec3 | null = null;

		search: for (const radius of radii) {
			const attempts = radius <= 4 ? 4 : Math.min(12, radius);

			for (let i = 0; i < attempts; i++) {
				if (signal.aborted) {
					return skillResult.fail("Aborted");
				}

				const angle = Math.random() * Math.PI * 2;
				const dist = Math.random() * radius;
				const tx = Math.floor(currentPos.x + Math.cos(angle) * dist);
				const tz = Math.floor(currentPos.z + Math.sin(angle) * dist);

				for (let ty = 120; ty >= 60; ty--) {
					const checkPos = new Vec3(tx, ty, tz);
					const block = bot.blockAt(checkPos);
					const up1 = bot.blockAt(checkPos.offset(0, 1, 0));
					const up2 = bot.blockAt(checkPos.offset(0, 2, 0));

					if (!block || !up1 || !up2) continue;

					if (
						!isTransparent(block.name) &&
						isSafeBlock(block.name) &&
						isTransparent(up1.name) &&
						isTransparent(up2.name)
					) {
						targetPos = new Vec3(tx + 0.5, ty + 1, tz + 0.5);
						agent.log(`[goto.surface] Found surface at (${tx}, ${ty}, ${tz}), radius=${radius}`);
						break search;
					}
				}
			}
		}

		if (targetPos) {
			try {
				const goal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1);
				await agent.abortableGoto(signal, goal);
				return skillResult.ok(`Reached surface at Y=${Math.floor(targetPos.y)}.`, {
					y: Math.floor(targetPos.y),
					method: "pathfinder",
				});
			} catch (err) {
				agent.log(`[goto.surface] Pathfinding failed, falling back to dig-up: ${err}`);
			}
		}

		agent.log(`[goto.surface] No surface path found, attempting dig-up...`);

		const digUpTargetY = Math.min(320, startY + 30);
		let currentDigY = startY;

		while (currentDigY < digUpTargetY) {
			if (signal.aborted) {
				return skillResult.fail("Aborted");
			}

			const checkPos = new Vec3(
				Math.floor(currentPos.x),
				currentDigY + 1,
				Math.floor(currentPos.z),
			);
			const block = bot.blockAt(checkPos);
			const above = bot.blockAt(checkPos.offset(0, 1, 0));

			if (!block || block.name === "air") {
				currentDigY++;
				continue;
			}

			if (!above || above.name === "air") {
				const goal = new goals.GoalNear(checkPos.x, checkPos.y, checkPos.z, 1);
				try {
					await agent.abortableGoto(signal, goal);
					return skillResult.ok(`Reached surface at Y=${checkPos.y}.`, {
						y: checkPos.y,
						method: "dig-up",
					});
				} catch {
					currentDigY++;
					continue;
				}
			}

			agent.log(`[goto.surface] Digging up at Y=${currentDigY + 1}...`);
			const toolPlugin = (bot as any).tool;
			if (toolPlugin) {
				await toolPlugin.equipForBlock(block);
			}

			try {
				await agent.abortableDig(signal, block);
				await new Promise((r) => setTimeout(r, 100));
			} catch {
				return skillResult.fail("Dig-up aborted or failed");
			}

			currentDigY++;
		}

		return skillResult.fail("Could not reach surface.");
	},
});
