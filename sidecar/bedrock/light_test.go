package main

import "testing"

// testWorld は Y区画 from..to だけを空気で埋めた、1列ぶんの世界を作る。
// 明るさの計算はブロックの並びだけで決まるので、実際のチャンクを
// 復元しなくても確かめられる。
func testWorld(from, to int8) *world {
	w := newWorld()
	for i := from; i <= to; i++ {
		w.put(0, 0, subChunk{
			Index:    i,
			Storages: []blockStorage{{PaletteNames: []string{"air"}}},
		})
	}
	return w
}

const (
	tickNoon  = int32(6000)
	tickNight = int32(18000)
)

func TestSkyOpenFollowsTime(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}

	if got, ok := w.lightAt(p, tickNoon); !ok || got != 15 {
		t.Fatalf("昼の露天は15のはず: got=%d ok=%v", got, ok)
	}
	// 夜の地上が7以下でないと、湧き潰しの判断が一切立たない。
	if got, ok := w.lightAt(p, tickNight); !ok || got != 4 {
		t.Fatalf("夜の露天は4のはず: got=%d ok=%v", got, ok)
	}
}

func TestRoofBlocksSky(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}
	w.setBlock(1, 20, 1, "stone")

	if got, ok := w.lightAt(p, tickNoon); !ok || got != 0 {
		t.Fatalf("頭上が塞がっていれば昼でも0のはず: got=%d ok=%v", got, ok)
	}
}

func TestLeavesDoNotBlockSky(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}
	w.setBlock(1, 20, 1, "oak_leaves")

	// 木の下を「暗い」と答えると、昼の地上で松明を置き続けることになる。
	if got, ok := w.lightAt(p, tickNoon); !ok || got != 15 {
		t.Fatalf("葉は空明かりを止めないはず: got=%d ok=%v", got, ok)
	}
}

func TestTorchLightFalls(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}
	w.setBlock(1, 20, 1, "stone") // 空明かりを切る
	w.setBlock(4, 4, 1, "torch")  // 3マス離れた松明

	got, ok := w.lightAt(p, tickNoon)
	if !ok {
		t.Fatal("読めているはず")
	}
	if got != 11 {
		t.Fatalf("松明14から3マスぶん落ちて11のはず: got=%d", got)
	}
}

func TestWallBlocksTorch(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}
	w.setBlock(1, 20, 1, "stone")

	// 松明を石で完全に囲む。直線距離で測る実装だとここで光が漏れる。
	w.setBlock(6, 4, 1, "torch")
	for _, d := range [][3]int32{
		{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1},
	} {
		w.setBlock(6+d[0], 4+d[1], 1+d[2], "stone")
	}

	if got, ok := w.lightAt(p, tickNoon); !ok || got != 0 {
		t.Fatalf("囲われた松明の光は届かないはず: got=%d ok=%v", got, ok)
	}
}

func TestLavaLightsCave(t *testing.T) {
	w := testWorld(0, 4)
	p := blockPos{1, 4, 1}
	w.setBlock(1, 20, 1, "stone")
	w.setBlock(2, 4, 1, "lava")

	if got, ok := w.lightAt(p, tickNoon); !ok || got != 14 {
		t.Fatalf("隣の溶岩で15-1=14のはず: got=%d ok=%v", got, ok)
	}
}

func TestUnloadedIsUnknown(t *testing.T) {
	w := testWorld(0, 4)

	// 持っていない列。0 や 15 に丸めず「分からない」と答えること。
	if got, ok := w.lightAt(blockPos{999, 4, 999}, tickNoon); ok {
		t.Fatalf("未読み込みは ok=false のはず: got=%d", got)
	}
}
