package api

import "testing"

func TestPrivateFeedURLIsScopedToUser(t *testing.T) {
	first := privateFeedURL("user-one")
	second := privateFeedURL("user-two")
	if first == second || first != "feedmind://selected/user-one" {
		t.Fatalf("privateFeedURL() returned %q and %q", first, second)
	}
}

func TestArticleIdentityIsStable(t *testing.T) {
	first := articleIdentity("https://example.com/article")
	second := articleIdentity("https://example.com/article")
	other := articleIdentity("https://example.com/other")
	if first != second || first == other || len(first) != 64 {
		t.Fatalf("articleIdentity() returned %q, %q and %q", first, second, other)
	}
}

func TestNormalizeDatabaseValueFormatsUUID(t *testing.T) {
	uuid := [16]byte{0xc4, 0x92, 0x90, 0xfe, 0x18, 0x3c, 0x79, 0x73, 0xac, 0x3f, 0x4b, 0x39, 0x8e, 0xa7, 0xca, 0x45}
	got := normalizeDatabaseValue(postgresUUIDOID, uuid)
	want := `c49290fe-183c-7973-ac3f-4b398ea7ca45`
	if got != want {
		t.Fatalf(`normalizeDatabaseValue() = %v, want %q`, got, want)
	}
}

func TestNormalizeDatabaseValueLeavesNonUUIDUnchanged(t *testing.T) {
	value := `unchanged`
	if got := normalizeDatabaseValue(25, value); got != value {
		t.Fatalf(`normalizeDatabaseValue() = %v, want %q`, got, value)
	}
}

func TestPageMetadataReturnsTotalAndRemovesInternalColumn(t *testing.T) {
	items := []map[string]any{
		{"id": "one", "__total": int64(3)},
		{"id": "two", "__total": int64(3)},
	}

	total, hasMore := pageMetadata(items, 1)
	if total != 3 {
		t.Fatalf("pageMetadata() total = %d, want 3", total)
	}
	if !hasMore {
		t.Fatal("pageMetadata() hasMore = false, want true")
	}
	for _, item := range items {
		if _, ok := item["__total"]; ok {
			t.Fatal("pageMetadata() left internal total column in an item")
		}
	}
}
