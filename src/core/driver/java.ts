/**
 * JavaDriver — mineflayer(Java版) を BotDriver インターフェースに適合させる実装。
 *
 * 既存の MinecraftAgent が持つ abortable 系ヘルパー（経路探索の詰まり検知や
 * 中断処理を含む）をそのまま流用する。ここでロジックを作り直さないこと。
 */
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { MinecraftAgent } from "../agent";
import type {
	BlockInfo,
	BotDriver,
	BotState,
	ControlState,
	EntityInfo,
	InventoryReader,
	ItemInfo,
	MoveGoal,
	Position,
	Registry,
	WorldReader,
} from "./types";

const toVec3 = (p: Position): Vec3 => new Vec3(p.x, p.y, p.z);
const toPosition = (v: { x: number; y: number; z: number }): Position => ({
	x: v.x,
	y: v.y,
	z: v.z,
});

function toBlockInfo(bot: any, block: any): BlockInfo | null {
	if (!block) return null;
	return {
		name: block.name,
		position: toPosition(block.position),
		diggable: bot.canDigBlock(block) ?? false,
		solid: block.boundingBox === "block",
	};
}

export class JavaDriver implements BotDriver {
	readonly world: WorldReader;
	readonly inventory: InventoryReader;
	readonly registry: Registry;

	constructor(private agent: MinecraftAgent) {
		// biome-ignore lint/complexity/noUselessThisAlias: クロージャ内から this を参照するため
		const self = this;

		this.world = {
			blockAt(position) {
				return toBlockInfo(self.bot, self.bot.blockAt(toVec3(position)));
			},
			findBlock(names, maxDistance) {
				const ids = self.blockIds(names);
				if (ids.length === 0) return null;
				return toBlockInfo(self.bot, self.bot.findBlock({ matching: ids, maxDistance }));
			},
			findBlocks(names, maxDistance, count) {
				const ids = self.blockIds(names);
				if (ids.length === 0) return [];
				return self.bot
					.findBlocks({ matching: ids, maxDistance, count })
					.map((v: Vec3) => toBlockInfo(self.bot, self.bot.blockAt(v)))
					.filter((b: BlockInfo | null): b is BlockInfo => b !== null);
			},
			findBlocksMatching(predicate, maxDistance, count) {
				return self.bot
					.findBlocks({
						matching: (block: any) => Boolean(block?.name) && predicate(block.name),
						maxDistance,
						count,
					})
					.map((v: Vec3) => toBlockInfo(self.bot, self.bot.blockAt(v)))
					.filter((b: BlockInfo | null): b is BlockInfo => b !== null);
			},
			getBiome(position) {
				try {
					const id = self.bot.world.getBiome(toVec3(position));
					return self.bot.registry.biomes[id]?.name ?? self.bot.game.dimension ?? "unknown";
				} catch {
					// チャンク未ロード時はここに来る
					return self.bot.game.dimension ?? "unknown";
				}
			},
			getLightLevel(position) {
				const block = self.bot.blockAt(toVec3(position));
				if (!block) return 0;
				return Math.max(block.light ?? 0, (block as any).skyLight ?? 0);
			},
		};

		this.inventory = {
			items() {
				return self.bot.inventory
					.items()
					.map((i: any): ItemInfo => ({ name: i.name, count: i.count, slot: i.slot }));
			},
			heldItem() {
				const h = self.bot.heldItem;
				return h ? { name: h.name, count: h.count, slot: h.slot } : null;
			},
			emptySlotCount() {
				return self.bot.inventory.emptySlotCount();
			},
		};

		this.registry = {
			hasBlock: (name) => Boolean(self.bot.registry.blocksByName[name]),
			hasItem: (name) => Boolean(self.bot.registry.itemsByName[name]),
		};
	}

	private get bot() {
		return this.agent.bot;
	}

	private blockIds(names: string[]): number[] {
		return names
			.map((n) => this.bot.registry.blocksByName[n]?.id)
			.filter((id): id is number => id !== undefined);
	}

	getState(): BotState {
		const bot = this.bot;
		const entity = bot.entity;
		return {
			username: bot.username,
			position: entity ? toPosition(entity.position) : { x: 0, y: 0, z: 0 },
			yaw: entity?.yaw ?? 0,
			health: bot.health,
			food: bot.food,
			timeOfDay: bot.time.timeOfDay,
			isRaining: bot.isRaining,
			dimension: bot.game.dimension ?? "unknown",
			isReady: Boolean(entity),
		};
	}

	nearbyEntities(maxDistance: number): EntityInfo[] {
		const bot = this.bot;
		if (!bot.entity) return [];
		const origin = bot.entity.position;
		return Object.values(bot.entities)
			.filter((e: any) => e.position && e.position.distanceTo(origin) < maxDistance)
			.map((e: any) => ({
				id: e.id,
				name: e.name ?? e.displayName ?? e.type,
				kind: e.type,
				position: toPosition(e.position),
				username: e.username,
			}));
	}

	private toGoal(goal: MoveGoal): goals.Goal {
		switch (goal.kind) {
			case "near":
				return new goals.GoalNear(goal.position.x, goal.position.y, goal.position.z, goal.distance);
			case "block":
				return new goals.GoalBlock(goal.position.x, goal.position.y, goal.position.z);
			case "getToBlock":
				return new goals.GoalGetToBlock(goal.position.x, goal.position.y, goal.position.z);
			case "xz":
				return new goals.GoalNearXZ(goal.x, goal.z, goal.distance);
			case "lookAtBlock":
				return new goals.GoalLookAtBlock(toVec3(goal.position), this.bot.world);
			case "follow": {
				const entity = this.bot.entities[goal.entityId];
				if (!entity) throw new Error(`Entity ${goal.entityId} not found`);
				return new goals.GoalFollow(entity, goal.distance);
			}
		}
	}

	async goto(signal: AbortSignal, goal: MoveGoal): Promise<void> {
		await this.agent.abortableGoto(signal, this.toGoal(goal));
	}

	stopMoving(): void {
		this.bot.pathfinder.stop();
		this.bot.clearControlStates();
	}

	async setControlState(
		signal: AbortSignal,
		state: ControlState,
		value: boolean,
		durationMs?: number,
	): Promise<void> {
		await this.agent.abortableSetControlState(signal, state, value);
		if (durationMs !== undefined && value) {
			await new Promise((r) => setTimeout(r, durationMs));
			await this.agent.abortableSetControlState(signal, state, false);
		}
	}

	clearControlStates(): void {
		this.bot.clearControlStates();
	}

	async lookAt(position: Position): Promise<void> {
		await this.bot.lookAt(toVec3(position));
	}

	async dig(signal: AbortSignal, position: Position): Promise<void> {
		const block = this.bot.blockAt(toVec3(position));
		if (!block) throw new Error(`No block at ${position.x},${position.y},${position.z}`);
		await this.agent.abortableDig(signal, block);
	}

	async placeBlock(signal: AbortSignal, reference: Position, face: Position): Promise<void> {
		if (this.agent.checkAbort(signal)) throw new Error("Aborted");
		const block = this.bot.blockAt(toVec3(reference));
		if (!block) {
			throw new Error(`No reference block at ${reference.x},${reference.y},${reference.z}`);
		}
		await this.bot.placeBlock(block, toVec3(face));
	}

	async activateBlock(position: Position): Promise<void> {
		const block = this.bot.blockAt(toVec3(position));
		if (!block) throw new Error(`No block at ${position.x},${position.y},${position.z}`);
		await this.bot.activateBlock(block);
	}

	async attack(signal: AbortSignal, entityId: number): Promise<void> {
		const target = this.bot.entities[entityId];
		if (!target) throw new Error(`Entity ${entityId} not found`);
		await this.agent.abortableAttack(signal, target);
	}

	async equip(itemName: string, destination: Parameters<BotDriver["equip"]>[1]): Promise<void> {
		const item = this.bot.inventory.items().find((i: any) => i.name === itemName);
		if (!item) throw new Error(`Item ${itemName} not in inventory`);
		await this.bot.equip(item, destination);
	}

	async equipBestTool(position: Position): Promise<void> {
		const block = this.bot.blockAt(toVec3(position));
		if (!block) throw new Error(`No block at ${position.x},${position.y},${position.z}`);
		const tool = (this.bot as any).tool;
		if (!tool) return; // プラグイン未ロード時は何もしない（素手で掘る）
		await tool.equipForBlock(block);
	}

	async pickupNearbyItems(signal: AbortSignal): Promise<void> {
		await this.agent.pickupNearbyItems(signal);
	}

	private recipeFor(itemName: string, craftingTable?: Position) {
		const item = this.bot.registry.itemsByName[itemName];
		if (!item) return null;
		const table = craftingTable ? this.bot.blockAt(toVec3(craftingTable)) : null;
		return this.bot.recipesFor(item.id, null, 1, table)[0] ?? null;
	}

	async craft(itemName: string, count: number, craftingTable?: Position): Promise<void> {
		const recipe = this.recipeFor(itemName, craftingTable);
		if (!recipe) throw new Error(`No recipe for ${itemName}`);
		const table = craftingTable ? this.bot.blockAt(toVec3(craftingTable)) : null;
		await this.bot.craft(recipe, count, table ?? undefined);
	}

	canCraft(itemName: string, craftingTable?: Position): boolean {
		return this.recipeFor(itemName, craftingTable) !== null;
	}

	canSmelt(itemName: string): boolean {
		const item = this.bot.registry.itemsByName[itemName];
		if (!item) return false;
		// recipesAll の第3引数 false でかまどレシピ側を引く（元実装と同じ判定）
		return this.bot.recipesAll(item.id, 1, false).length > 0;
	}

	async smelt(
		furnace: Position,
		input: string,
		inputCount: number,
		fuel: string,
		fuelCount: number,
	): Promise<void> {
		const block = this.bot.blockAt(toVec3(furnace));
		if (!block) throw new Error("No furnace at given position");
		const f = await this.bot.openFurnace(block);
		try {
			const fuelItem = this.bot.inventory.items().find((i: any) => i.name === fuel);
			const inputItem = this.bot.inventory.items().find((i: any) => i.name === input);
			if (!fuelItem) throw new Error(`No fuel ${fuel}`);
			if (!inputItem) throw new Error(`No input ${input}`);
			await f.putFuel(fuelItem.type, null, fuelCount);
			await f.putInput(inputItem.type, null, inputCount);
		} finally {
			f.close();
		}
	}

	async takeAllFromContainer(signal: AbortSignal, position: Position): Promise<number> {
		if (this.agent.checkAbort(signal)) throw new Error("Aborted");
		const block = this.bot.blockAt(toVec3(position));
		if (!block) throw new Error(`No container at ${position.x},${position.y},${position.z}`);

		const container = await this.bot.openContainer(block);
		try {
			const items = container.containerItems();
			let taken = 0;
			for (const item of items) {
				if (this.agent.checkAbort(signal)) break;
				// インベントリがいっぱいなら打ち切る
				if (this.bot.inventory.emptySlotCount() === 0) break;
				await container.withdraw(item.type, null, item.count);
				taken++;
			}
			return taken;
		} finally {
			container.close();
		}
	}

	async chat(message: string): Promise<void> {
		this.bot.chat(message);
	}

	async connect(): Promise<void> {
		// 接続は MinecraftAgent のコンストラクタ内で行われるため何もしない
	}

	async disconnect(): Promise<void> {
		this.bot.quit();
	}

	on(event: string, listener: (...args: any[]) => void): void {
		this.bot.on(event as any, listener);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		this.bot.off(event as any, listener);
	}
}
