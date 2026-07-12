package api

import "testing"

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
