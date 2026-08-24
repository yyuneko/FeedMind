package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

type thinkingEvent struct {
	ID        string          `json:"id"`
	Sequence  int             `json:"sequence"`
	Kind      string          `json:"kind"`
	Content   string          `json:"content"`
	Metadata  json.RawMessage `json:"metadata"`
	CreatedAt time.Time       `json:"createdAt"`
}

type thinkingSession struct {
	ID                 string          `json:"id"`
	ArticleID          string          `json:"articleId"`
	ArticleContentHash string          `json:"articleContentHash"`
	Status             string          `json:"status"`
	Stage              string          `json:"stage"`
	CompletedRounds    int             `json:"completedRounds"`
	Coverage           json.RawMessage `json:"coverage"`
	CoachState         json.RawMessage `json:"coachState"`
	Report             json.RawMessage `json:"report"`
	Version            int64           `json:"version"`
	StartedAt          time.Time       `json:"startedAt"`
	CompletedAt        *time.Time      `json:"completedAt"`
	UpdatedAt          time.Time       `json:"updatedAt"`
	Events             []thinkingEvent `json:"events,omitempty"`
}

func validThinkingStatus(value string) bool {
	return value == "active" || value == "completed" || value == "abandoned"
}

func validThinkingEventKind(value string) bool {
	switch value {
	case "question", "answer", "feedback", "hint", "explanation":
		return true
	default:
		return false
	}
}

func validThinkingStage(value string) bool {
	switch value {
	case "summary", "argument", "logic", "importance", "critique", "connection", "complete":
		return true
	default:
		return false
	}
}

func isJSONObject(raw json.RawMessage) bool {
	var value map[string]any
	return len(raw) > 0 && json.Unmarshal(raw, &value) == nil && value != nil
}

func validJSONOrDefault(raw json.RawMessage, fallback string) json.RawMessage {
	if len(raw) == 0 || !json.Valid(raw) {
		return json.RawMessage(fallback)
	}
	return raw
}

func scanThinkingSession(row pgx.Row) (thinkingSession, error) {
	var item thinkingSession
	var coverage, coachState, report []byte
	err := row.Scan(&item.ID, &item.ArticleID, &item.ArticleContentHash, &item.Status, &item.Stage,
		&item.CompletedRounds, &coverage, &coachState, &report, &item.Version,
		&item.StartedAt, &item.CompletedAt, &item.UpdatedAt)
	item.Coverage = validJSONOrDefault(coverage, "{}")
	item.CoachState = validJSONOrDefault(coachState, "{}")
	if len(report) > 0 && string(report) != "null" {
		item.Report = validJSONOrDefault(report, "null")
	}
	return item, err
}

const thinkingSessionColumns = `id,article_id,article_content_hash,status,stage,completed_rounds,coverage,coach_state,report,version,started_at,completed_at,updated_at`

func (s *Server) thinkingSessionByID(r *http.Request, sessionID, userID string, withEvents bool) (thinkingSession, error) {
	item, err := scanThinkingSession(s.DB.QueryRow(r.Context(), `SELECT `+thinkingSessionColumns+` FROM thinking_sessions WHERE id=$1 AND user_id=$2`, sessionID, userID))
	if err != nil || !withEvents {
		return item, err
	}
	rows, err := s.DB.Query(r.Context(), `SELECT id,sequence,kind,content,metadata,created_at FROM thinking_events WHERE session_id=$1 ORDER BY sequence`, sessionID)
	if err != nil {
		return item, err
	}
	defer rows.Close()
	item.Events = []thinkingEvent{}
	for rows.Next() {
		var event thinkingEvent
		var metadata []byte
		if err = rows.Scan(&event.ID, &event.Sequence, &event.Kind, &event.Content, &metadata, &event.CreatedAt); err != nil {
			return item, err
		}
		event.Metadata = validJSONOrDefault(metadata, "{}")
		item.Events = append(item.Events, event)
	}
	return item, rows.Err()
}

func (s *Server) listThinkingSessions(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	articleID := chi.URLParam(r, "id")
	rows, err := s.DB.Query(r.Context(), `SELECT `+thinkingSessionColumns+` FROM thinking_sessions ts WHERE article_id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM articles a JOIN user_feed_subscriptions us ON us.feed_id=a.feed_id AND us.user_id=$2 WHERE a.id=ts.article_id) ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,started_at DESC`, articleID, u.ID)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	defer rows.Close()
	items := []thinkingSession{}
	for rows.Next() {
		item, scanErr := scanThinkingSession(rows)
		if scanErr != nil {
			fail(w, r, 500, "internal", "Request failed", scanErr)
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	jsonOut(w, 200, map[string]any{"items": items})
}

func (s *Server) createThinkingSession(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	articleID := chi.URLParam(r, "id")
	var in struct{ ArticleContentHash string }
	if decode(r, &in) != nil || strings.TrimSpace(in.ArticleContentHash) == "" {
		fail(w, r, 422, "validation_failed", "Article content hash is required")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	defer tx.Rollback(r.Context())
	var currentHash string
	err = tx.QueryRow(r.Context(), `SELECT a.content_hash FROM articles a JOIN user_feed_subscriptions us ON us.feed_id=a.feed_id AND us.user_id=$2 WHERE a.id=$1`, articleID, u.ID).Scan(&currentHash)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, r, 404, "not_found", "Article not found")
		return
	}
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	if currentHash != in.ArticleContentHash {
		fail(w, r, 409, "article_changed", "Article content has changed")
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE thinking_sessions SET status='abandoned',updated_at=now(),version=version+1 WHERE user_id=$1 AND article_id=$2 AND status='active' AND article_content_hash<>$3`, u.ID, articleID, currentHash)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	item, err := scanThinkingSession(tx.QueryRow(r.Context(), `SELECT `+thinkingSessionColumns+` FROM thinking_sessions WHERE user_id=$1 AND article_id=$2 AND status='active'`, u.ID, articleID))
	created := false
	if errors.Is(err, pgx.ErrNoRows) {
		item, err = scanThinkingSession(tx.QueryRow(r.Context(), `INSERT INTO thinking_sessions(user_id,article_id,article_content_hash) VALUES($1,$2,$3) ON CONFLICT(user_id,article_id) WHERE status='active' DO NOTHING RETURNING `+thinkingSessionColumns, u.ID, articleID, currentHash))
		if errors.Is(err, pgx.ErrNoRows) {
			item, err = scanThinkingSession(tx.QueryRow(r.Context(), `SELECT `+thinkingSessionColumns+` FROM thinking_sessions WHERE user_id=$1 AND article_id=$2 AND status='active'`, u.ID, articleID))
		} else {
			created = err == nil
		}
	}
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	status := 200
	if created {
		status = 201
	}
	jsonOut(w, status, map[string]any{"session": item, "created": created})
}

func (s *Server) getThinkingSession(w http.ResponseWriter, r *http.Request) {
	item, err := s.thinkingSessionByID(r, chi.URLParam(r, "id"), userOf(r).ID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, r, 404, "not_found", "Thinking session not found")
		return
	}
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	jsonOut(w, 200, item)
}

func (s *Server) appendThinkingEvents(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	sessionID := chi.URLParam(r, "id")
	var in struct {
		ExpectedVersion int64
		OperationID     string
		Events          []struct {
			Kind     string          `json:"kind"`
			Content  string          `json:"content"`
			Metadata json.RawMessage `json:"metadata"`
		}
		Stage           string          `json:"stage"`
		CompletedRounds int             `json:"completedRounds"`
		Coverage        json.RawMessage `json:"coverage"`
		CoachState      json.RawMessage `json:"coachState"`
		Report          json.RawMessage `json:"report"`
		Status          string          `json:"status"`
	}
	if decode(r, &in) != nil || in.ExpectedVersion < 1 || strings.TrimSpace(in.OperationID) == "" || len(in.Events) == 0 || len(in.Events) > 3 || in.CompletedRounds < 0 || in.CompletedRounds > 5 || !validThinkingStatus(in.Status) || !validThinkingStage(in.Stage) {
		fail(w, r, 422, "validation_failed", "Invalid thinking session update")
		return
	}
	if in.Status == "completed" && (in.Stage != "complete" || in.CompletedRounds < 3 || !isJSONObject(in.Report)) {
		fail(w, r, 422, "validation_failed", "Completed training requires a report after 3 to 5 rounds")
		return
	}
	for _, event := range in.Events {
		if !validThinkingEventKind(event.Kind) || strings.TrimSpace(event.Content) == "" || (len(event.Metadata) > 0 && !json.Valid(event.Metadata)) {
			fail(w, r, 422, "validation_failed", "Invalid thinking event")
			return
		}
	}
	if !json.Valid(validJSONOrDefault(in.Coverage, "{}")) || !json.Valid(validJSONOrDefault(in.CoachState, "{}")) || (len(in.Report) > 0 && !json.Valid(in.Report)) {
		fail(w, r, 422, "validation_failed", "Invalid thinking state")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	defer tx.Rollback(r.Context())
	var version int64
	var status string
	err = tx.QueryRow(r.Context(), `SELECT version,status FROM thinking_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, sessionID, u.ID).Scan(&version, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, r, 404, "not_found", "Thinking session not found")
		return
	}
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	var duplicate bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM thinking_events WHERE session_id=$1 AND operation_id=$2)`, sessionID, in.OperationID+":0").Scan(&duplicate)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	if duplicate {
		_ = tx.Rollback(r.Context())
		item, loadErr := s.thinkingSessionByID(r, sessionID, u.ID, true)
		if loadErr != nil {
			fail(w, r, 500, "internal", "Request failed", loadErr)
			return
		}
		jsonOut(w, 200, item)
		return
	}
	if status != "active" {
		fail(w, r, 409, "session_closed", "Thinking session is no longer active")
		return
	}
	if version != in.ExpectedVersion {
		fail(w, r, 409, "version_conflict", "Thinking session was updated elsewhere")
		return
	}
	var nextSequence int
	if err = tx.QueryRow(r.Context(), `SELECT COALESCE(MAX(sequence),0)+1 FROM thinking_events WHERE session_id=$1`, sessionID).Scan(&nextSequence); err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	for index, event := range in.Events {
		metadata := validJSONOrDefault(event.Metadata, "{}")
		_, err = tx.Exec(r.Context(), `INSERT INTO thinking_events(session_id,sequence,kind,content,metadata,operation_id) VALUES($1,$2,$3,$4,$5,$6)`, sessionID, nextSequence+index, event.Kind, strings.TrimSpace(event.Content), metadata, fmt.Sprintf("%s:%d", in.OperationID, index))
		if err != nil {
			fail(w, r, 500, "internal", "Request failed", err)
			return
		}
	}
	report := validJSONOrDefault(in.Report, "null")
	coverage := validJSONOrDefault(in.Coverage, "{}")
	coachState := validJSONOrDefault(in.CoachState, "{}")
	_, err = tx.Exec(r.Context(), `UPDATE thinking_sessions SET status=$1,stage=$2,completed_rounds=$3,coverage=$4,coach_state=$5,report=$6,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$7`, in.Status, in.Stage, in.CompletedRounds, coverage, coachState, report, sessionID)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	item, err := s.thinkingSessionByID(r, sessionID, u.ID, true)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	jsonOut(w, 200, item)
}

func (s *Server) abandonThinkingSession(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var in struct{ ExpectedVersion int64 }
	if decode(r, &in) != nil || in.ExpectedVersion < 1 {
		fail(w, r, 422, "validation_failed", "Expected version is required")
		return
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE thinking_sessions SET status='abandoned',version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='active' AND version=$3`, chi.URLParam(r, "id"), u.ID, in.ExpectedVersion)
	if err != nil {
		fail(w, r, 500, "internal", "Request failed", err)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, r, 409, "version_conflict", "Thinking session was updated elsewhere")
		return
	}
	w.WriteHeader(204)
}
