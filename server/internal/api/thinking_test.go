package api

import (
	"encoding/json"
	"testing"
)

func TestThinkingStatusValidation(t *testing.T) {
	for _, value := range []string{"active", "completed", "abandoned"} {
		if !validThinkingStatus(value) {
			t.Fatalf("validThinkingStatus(%q) = false", value)
		}
	}
	for _, value := range []string{"", "pending", "deleted"} {
		if validThinkingStatus(value) {
			t.Fatalf("validThinkingStatus(%q) = true", value)
		}
	}
}

func TestThinkingEventKindValidation(t *testing.T) {
	for _, value := range []string{"question", "answer", "feedback", "hint", "explanation"} {
		if !validThinkingEventKind(value) {
			t.Fatalf("validThinkingEventKind(%q) = false", value)
		}
	}
	if validThinkingEventKind("report") || validThinkingEventKind("") {
		t.Fatal("invalid event kind was accepted")
	}
}

func TestThinkingStageAndReportValidation(t *testing.T) {
	for _, value := range []string{"summary", "argument", "logic", "importance", "critique", "connection", "complete"} {
		if !validThinkingStage(value) {
			t.Fatalf("validThinkingStage(%q) = false", value)
		}
	}
	if validThinkingStage("finished") {
		t.Fatal("invalid thinking stage was accepted")
	}
	if !isJSONObject(json.RawMessage(`{"articleCore":"core"}`)) || isJSONObject(json.RawMessage(`[]`)) || isJSONObject(nil) {
		t.Fatal("thinking report object validation failed")
	}
}

func TestThinkingJSONDefaultsRemainValid(t *testing.T) {
	if got := validJSONOrDefault(nil, "{}"); string(got) != "{}" {
		t.Fatalf("empty JSON default = %q", got)
	}
	if got := validJSONOrDefault(json.RawMessage(`{"summary":true}`), "{}"); string(got) != `{"summary":true}` {
		t.Fatalf("valid JSON changed to %q", got)
	}
	if got := validJSONOrDefault(json.RawMessage(`{broken`), "null"); string(got) != "null" {
		t.Fatalf("invalid JSON default = %q", got)
	}
}
