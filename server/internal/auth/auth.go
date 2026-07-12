package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
	"strings"
	"time"
)

type Service struct {
	DB                    *pgxpool.Pool
	Secret                []byte
	AccessTTL, RefreshTTL time.Duration
}
type User struct {
	ID, Email string
	Verified  bool
}
type Tokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int64  `json:"expiresIn"`
}
type claims struct {
	jwt.RegisteredClaims
	Email string `json:"email"`
}

func HashPassword(password string) (string, error) {
	if len(password) < 10 || len(password) > 256 {
		return "", errors.New("password must contain 10-256 characters")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	h := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(h)), nil
}
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}
func NormalizeEmail(x string) string { return strings.ToLower(strings.TrimSpace(x)) }
func randomToken() (string, []byte, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", nil, e
	}
	raw := base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(raw))
	return raw, sum[:], nil
}
func (s *Service) issueAccess(u User, sessionID string) (string, error) {
	now := time.Now()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims{RegisteredClaims: jwt.RegisteredClaims{Subject: u.ID, ID: sessionID, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(s.AccessTTL)), Issuer: "feedmind"}, Email: u.Email}).SignedString(s.Secret)
}
func (s *Service) NewSession(ctx context.Context, u User, device string) (Tokens, error) {
	refresh, hash, e := randomToken()
	if e != nil {
		return Tokens{}, e
	}
	var id string
	e = s.DB.QueryRow(ctx, "INSERT INTO auth_sessions(user_id,refresh_hash,device_name,expires_at) VALUES($1,$2,$3,$4) RETURNING id", u.ID, hash, device, time.Now().Add(s.RefreshTTL)).Scan(&id)
	if e != nil {
		return Tokens{}, e
	}
	access, e := s.issueAccess(u, id)
	return Tokens{access, refresh, int64(s.AccessTTL.Seconds())}, e
}
func (s *Service) ParseAccess(raw string) (User, string, error) {
	token, e := jwt.ParseWithClaims(raw, &claims{}, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return s.Secret, nil
	}, jwt.WithIssuer("feedmind"), jwt.WithExpirationRequired())
	if e != nil {
		return User{}, "", e
	}
	c, ok := token.Claims.(*claims)
	if !ok || !token.Valid {
		return User{}, "", errors.New("invalid token")
	}
	return User{ID: c.Subject, Email: c.Email}, c.ID, nil
}
func (s *Service) Rotate(ctx context.Context, raw string) (Tokens, error) {
	sum := sha256.Sum256([]byte(raw))
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return Tokens{}, e
	}
	defer tx.Rollback(ctx)
	var id string
	var u User
	e = tx.QueryRow(ctx, `SELECT s.id,u.id,u.email,u.email_verified_at IS NOT NULL FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE`, sum[:]).Scan(&id, &u.ID, &u.Email, &u.Verified)
	if e != nil {
		return Tokens{}, errors.New("invalid refresh token")
	}
	next, nextHash, e := randomToken()
	if e != nil {
		return Tokens{}, e
	}
	if _, e = tx.Exec(ctx, "UPDATE auth_sessions SET refresh_hash=$1,last_rotated_at=now() WHERE id=$2", nextHash, id); e != nil {
		return Tokens{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Tokens{}, e
	}
	access, e := s.issueAccess(u, id)
	return Tokens{access, next, int64(s.AccessTTL.Seconds())}, e
}
func (s *Service) Revoke(ctx context.Context, sessionID string, all bool, userID string) error {
	q := "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2"
	args := []any{sessionID, userID}
	if all {
		q = "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1"
		args = []any{userID}
	}
	_, e := s.DB.Exec(ctx, q, args...)
	return e
}
