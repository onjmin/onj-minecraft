package main

import "testing"

// 足場に数える物の判定。素材や食べ物を「置ける」と数えると、柱を積むときに
// それを握って何も置けず、経路探索は足場があると信じて柱の手を出し続ける。
func TestIsPlaceableName(t *testing.T) {
	for _, name := range []string{"dirt", "cobblestone", "oak_planks", "spruce_log", "white_wool", "sand", "gravel"} {
		if !isPlaceableName(name) {
			t.Errorf("%s は置けるはず", name)
		}
	}
	for _, name := range []string{
		"clay_ball", "snowball", "rotten_flesh", "feather", "leather", "egg", "beef", "mutton",
		"oak_sapling", "torch", "wooden_sword", "stick", "wheat_seeds", "bed", "shears",
	} {
		if isPlaceableName(name) {
			t.Errorf("%s は足場にならないはず", name)
		}
	}
}
