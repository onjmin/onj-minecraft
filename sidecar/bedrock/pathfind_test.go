package main

import "testing"

// 水没した床は「立てる」に数えない。
//
// 水は通れるので、以前は水底の床を地面として何手も歩かせていた。息は
// 十数秒しか続かない。腰までの水(頭は空気)は歩けてよい。
func TestStandableRefusesSubmerged(t *testing.T) {
	w := testWorld(0, 4)
	w.setBlock(1, 9, 1, "stone")
	w.setBlock(1, 10, 1, "water")
	if !w.standable(blockPos{1, 10, 1}) {
		t.Fatal("腰までの水は立てるはず")
	}
	w.setBlock(1, 11, 1, "water")
	if w.standable(blockPos{1, 10, 1}) {
		t.Fatal("頭まで水なら立てないはず")
	}
}

// 横に泳ぐ手は水面だけ。頭まで沈んだまま横へ進む手は出さない。
// 潜った所からは真上へ浮く手だけが出る。
func TestSwimMovesStayOnSurface(t *testing.T) {
	w := testWorld(0, 4)
	// 深さ3の水たまり。床は y=8、水は y=9..11、空気は y=12〜。
	for x := int32(0); x <= 3; x++ {
		w.setBlock(x, 8, 1, "stone")
		for y := int32(9); y <= 11; y++ {
			w.setBlock(x, y, 1, "water")
		}
	}
	bottom := blockPos{1, 9, 1}
	surface := blockPos{1, 11, 1}
	caps := caps{CanDig: false, Blocks: 0}

	for _, m := range w.moves(bottom, caps) {
		if m.step.Action == stepSwim || m.step.Action == stepWalk {
			t.Fatalf("水底から横へ進む手が出た: %+v", m.step)
		}
	}
	found := false
	for _, m := range w.moves(surface, caps) {
		if m.step.Action == stepSwim {
			found = true
		}
	}
	if !found {
		t.Fatal("水面では横へ泳ぐ手が出るはず")
	}
}
