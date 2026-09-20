package main

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// craftSession は持ち物の写しだけを持つ session を作る。
// クラフトの写しの更新は接続を要らないので、これで確かめられる。
func craftSession(raw map[int]protocol.ItemInstance) *session {
	s := &session{
		itemNames: map[int32]string{
			5:  "oak_log",
			6:  "oak_planks",
			7:  "stick",
			8:  "crafting_table",
			99: "dirt",
		},
		rawSlots: map[int]protocol.ItemInstance{},
	}
	for slot, it := range raw {
		s.rawSlots[slot] = it
		s.syncSlotLocked(slot, it)
	}
	return s
}

func stack(netID int32, stackID int32, count uint16) protocol.ItemInstance {
	return protocol.ItemInstance{
		StackNetworkID: stackID,
		Stack: protocol.ItemStack{
			ItemType: protocol.ItemType{NetworkID: netID},
			Count:    count,
		},
	}
}

// 拾った棒(識別子 0)を持っているとき、棒を作ると出来上がりは空き枠へ入る
// (outputSlotLocked は識別子 0 の山へ重ねない)。写しもその空き枠に置かなければ
// ならない。以前は「同じ名前の山があればそこへ足す」だったので、写しは拾った
// 棒の山を 1→5 にし、サーバーが使った枠を空きのまま残していた。次の作業台の
// 出来上がりの行き先にその枠を選び、FailedToValidateDstSlot(50) で拒否され
// 続けた(実測 2026-09-19 22:08、wood-tool)。
func TestApplyCraftPutsOutputWhereRequested(t *testing.T) {
	s := craftSession(map[int]protocol.ItemInstance{
		0: stack(5, 89, 9), // oak_log
		2: stack(6, 91, 4), // oak_planks
		3: stack(7, 0, 1),  // 拾った stick。識別子は不明
	})

	dest, destID, ok := s.outputSlotLocked("stick", map[int]int{2: 2})
	if !ok || dest == 3 || destID != 0 {
		t.Fatalf("識別子 0 の山へ重ねてはいけない: dest=%d id=%d ok=%v", dest, destID, ok)
	}

	s.applyCraftLocked(craftOutcome{
		Output:      "stick",
		OutputCount: 4,
		Spent:       map[int]int{2: 2},
		Dest:        dest,
	})

	if got := s.rawSlots[3].Stack.Count; got != 1 {
		t.Fatalf("拾った棒の山は触らない: got=%d", got)
	}
	if got := s.rawSlots[dest].Stack.Count; got != 4 {
		t.Fatalf("出来上がりは要求した枠 %d へ: got=%d", dest, got)
	}
	if got := s.rawSlots[2].Stack.Count; got != 2 {
		t.Fatalf("板は指した枠から減る: got=%d", got)
	}

	// 次に作業台を作るとき、棒が入った枠を空きとして選んではいけない。
	next, _, ok := s.outputSlotLocked("crafting_table", map[int]int{2: 2})
	if !ok || next == dest || next == 3 {
		t.Fatalf("埋まった枠を行き先に選んだ: next=%d", next)
	}
}

// 素材は名前ではなく、要求で指した枠から減らす。
// 同じ物が2山あるとき、要求は rawSlots の走査順(不定)で取るので、
// 名前で「最初の山」から引くと写しとサーバーで減る山が食い違う。
func TestApplyCraftSpendsFromRequestedSlots(t *testing.T) {
	s := craftSession(map[int]protocol.ItemInstance{
		1: stack(6, 91, 2), // oak_planks 2
		4: stack(6, 92, 6), // oak_planks 6
	})

	s.applyCraftLocked(craftOutcome{
		Output:      "crafting_table",
		OutputCount: 1,
		Spent:       map[int]int{4: 4},
		Dest:        0,
	})

	if got := s.rawSlots[1].Stack.Count; got != 2 {
		t.Fatalf("指していない山は減らさない: got=%d", got)
	}
	if got := s.rawSlots[4].Stack.Count; got != 2 {
		t.Fatalf("指した山から4減る: got=%d", got)
	}
	if got := s.rawSlots[0]; got.Stack.ItemType.NetworkID != 8 || got.Stack.Count != 1 {
		t.Fatalf("出来上がりは枠0へ: %+v", got)
	}
	// 使い切った枠は写しから消える。
	s.applyCraftLocked(craftOutcome{
		Output:      "stick",
		OutputCount: 4,
		Spent:       map[int]int{1: 2},
		Dest:        5,
	})
	if _, still := s.rawSlots[1]; still {
		t.Fatalf("使い切った枠は消える")
	}
	for _, it := range s.slots {
		if it.Slot == 1 {
			t.Fatalf("外向きの一覧からも消える: %+v", it)
		}
	}
}
