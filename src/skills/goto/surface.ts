import type { Position } from "../../core/driver/types";
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
		const { driver } = agent;
		const state = driver.getState();
		if (!state.isReady) return skillResult.fail("Bot entity not loaded");
		const currentPos = state.position;
		const startY = Math.floor(currentPos.y);

		agent.log(`[goto.surface] Current Y: ${startY}, searching for surface...`);

		const radii = [16, 8, 4];
		let targetPos: Position | null = null;

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
					const block = driver.world.blockAt({ x: tx, y: ty, z: tz });
					const up1 = driver.world.blockAt({ x: tx, y: ty + 1, z: tz });
					const up2 = driver.world.blockAt({ x: tx, y: ty + 2, z: tz });

					if (!block || !up1 || !up2) continue;

					if (
						!isTransparent(block.name) &&
						isSafeBlock(block.name) &&
						isTransparent(up1.name) &&
						isTransparent(up2.name)
					) {
						targetPos = { x: tx + 0.5, y: ty + 1, z: tz + 0.5 };
						agent.log(`[goto.surface] Found surface at (${tx}, ${ty}, ${tz}), radius=${radius}`);
						break search;
					}
				}
			}
		}

		if (targetPos) {
			try {
				await agent.driver.goto(signal, { kind: "near", position: targetPos, distance: 1 });
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

			const checkPos: Position = {
				x: Math.floor(currentPos.x),
				y: currentDigY + 1,
				z: Math.floor(currentPos.z),
			};
			const block = driver.world.blockAt(checkPos);
			const above = driver.world.blockAt({ ...checkPos, y: checkPos.y + 1 });

			if (!block || block.name === "air") {
				currentDigY++;
				continue;
			}

			if (!above || above.name === "air") {
				try {
					await driver.goto(signal, { kind: "near", position: checkPos, distance: 1 });
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
			await driver.equipBestTool(checkPos);

			try {
				await driver.dig(signal, checkPos);
				await new Promise((r) => setTimeout(r, 100));
			} catch {
				return skillResult.fail("Dig-up aborted or failed");
			}

			currentDigY++;
		}

		return skillResult.fail("Could not reach surface.");
	},
});
