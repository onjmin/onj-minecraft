package main

// ブロックを見ながらの経路探索。
//
// これが無いと、目標へ真っ直ぐ向かって起伏や木で止まる。実測でも平地では
// バニラ歩行の87%出るのに、起伏のある地形では28%まで落ちていた。
//
// 探索は立ち位置(足元の座標)を節点とする A*。移動できるかは
//   足元が通れる / 頭上が通れる / その下が固い
// の3つで判定する。未取得のマスは通れない扱いにする。空気と見なして進むと、
// 読み込みが追いつかない方向へ突っ込んで落ちる。

import (
	"container/heap"
	"math"
)

type blockPos struct{ X, Y, Z int32 }

// 通り抜けられるブロック。TypeScript 側の blockview.ts と揃えてある。
var passableBlocks = map[string]bool{
	"air": true, "cave_air": true, "void_air": true,
	"water": true, "flowing_water": true,
	"short_grass": true, "tall_grass": true, "fern": true, "large_fern": true,
	"dead_bush": true, "seagrass": true, "vine": true, "snow_layer": true,
	"torch": true, "soul_torch": true, "redstone_torch": true,
	"rail": true, "wheat": true, "carrots": true, "potatoes": true,
	"red_flower": true, "yellow_flower": true, "sapling": true,
}

// 上に乗ってはいけないもの。通れるかどうかとは別に、足場にすると死ぬ。
var hazardBlocks = map[string]bool{
	"lava": true, "flowing_lava": true, "fire": true, "soul_fire": true,
	"magma": true, "cactus": true, "sweet_berry_bush": true,
}

func (w *world) passable(p blockPos) bool {
	name, ok := w.blockAt(p.X, p.Y, p.Z)
	if !ok {
		// 未取得は通れないものとして扱う。空気と決めつけて進むより安全。
		return false
	}
	return passableBlocks[name]
}

// standable はそこに立てるか。足元と頭上が空いていて、その下が足場であること。
func (w *world) standable(p blockPos) bool {
	if !w.passable(p) || !w.passable(blockPos{p.X, p.Y + 1, p.Z}) {
		return false
	}
	below, ok := w.blockAt(p.X, p.Y-1, p.Z)
	if !ok || hazardBlocks[below] {
		return false
	}
	return !passableBlocks[below]
}

type pathNode struct {
	pos   blockPos
	g, f  float64
	index int
}

type nodeQueue []*pathNode

func (q nodeQueue) Len() int           { return len(q) }
func (q nodeQueue) Less(i, j int) bool { return q[i].f < q[j].f }
func (q nodeQueue) Swap(i, j int)      { q[i], q[j] = q[j], q[i]; q[i].index = i; q[j].index = j }
func (q *nodeQueue) Push(x any)        { n := x.(*pathNode); n.index = len(*q); *q = append(*q, n) }
func (q *nodeQueue) Pop() any          { old := *q; n := old[len(old)-1]; *q = old[:len(old)-1]; return n }

// 落ちてよい高さ。これを超える段差は経路に含めない。
const maxDrop = 3

// findPath は from から goal へ立って行ける道を返す。
// 見つからなければ nil。maxNodes は tick を止めないための上限。
func (w *world) findPath(from, goal blockPos, tolerance float64, maxNodes int) []blockPos {
	h := func(p blockPos) float64 {
		dx := float64(p.X - goal.X)
		dy := float64(p.Y - goal.Y)
		dz := float64(p.Z - goal.Z)
		return math.Sqrt(dx*dx+dz*dz) + math.Abs(dy)
	}
	reached := func(p blockPos) bool {
		dx := float64(p.X - goal.X)
		dz := float64(p.Z - goal.Z)
		return math.Sqrt(dx*dx+dz*dz) <= tolerance
	}

	start := &pathNode{pos: from, g: 0, f: h(from)}
	open := &nodeQueue{start}
	heap.Init(open)
	best := map[blockPos]float64{from: 0}
	cameFrom := map[blockPos]blockPos{}

	visited := 0
	for open.Len() > 0 {
		if visited >= maxNodes {
			return nil
		}
		visited++
		cur := heap.Pop(open).(*pathNode)
		if reached(cur.pos) {
			return reconstruct(cameFrom, from, cur.pos)
		}
		if cur.g > best[cur.pos] {
			continue
		}
		for _, next := range w.neighbours(cur.pos) {
			// 斜めは足さない。角抜けの判定が要るうえ、実際の歩行が安定しない。
			cost := cur.g + 1
			if next.Y != cur.pos.Y {
				// 上り下りは少し高くつけて、平らな道を優先させる。
				cost += 0.5
			}
			if old, seen := best[next]; seen && cost >= old {
				continue
			}
			best[next] = cost
			cameFrom[next] = cur.pos
			heap.Push(open, &pathNode{pos: next, g: cost, f: cost + h(next)})
		}
	}
	return nil
}

// neighbours は1歩で行ける立ち位置。水平4方向について、同じ高さ・1段上り・
// 落下(maxDrop まで)を見る。
func (w *world) neighbours(p blockPos) []blockPos {
	dirs := [4][2]int32{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	out := make([]blockPos, 0, 8)
	for _, d := range dirs {
		x, z := p.X+d[0], p.Z+d[1]

		// 同じ高さ
		if w.standable(blockPos{x, p.Y, z}) {
			out = append(out, blockPos{x, p.Y, z})
			continue
		}
		// 1段上る。頭上2つぶんが空いていないと跳べない。
		if w.passable(blockPos{p.X, p.Y + 2, p.Z}) && w.standable(blockPos{x, p.Y + 1, z}) {
			out = append(out, blockPos{x, p.Y + 1, z})
			continue
		}
		// 落ちる
		for dy := int32(1); dy <= maxDrop; dy++ {
			cand := blockPos{x, p.Y - dy, z}
			if w.standable(cand) {
				out = append(out, cand)
				break
			}
			// 途中が塞がっていればそれ以上は落ちられない
			if !w.passable(cand) {
				break
			}
		}
	}
	return out
}

func reconstruct(cameFrom map[blockPos]blockPos, from, to blockPos) []blockPos {
	path := []blockPos{to}
	cur := to
	for cur != from {
		prev, ok := cameFrom[cur]
		if !ok {
			break
		}
		cur = prev
		path = append(path, cur)
	}
	// 逆順に積んだので反転する。先頭は今いる場所なので落とす。
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	if len(path) > 0 {
		path = path[1:]
	}
	return path
}
