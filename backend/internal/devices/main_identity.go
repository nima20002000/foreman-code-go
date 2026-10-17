package devices

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

var ErrCorruptMainIdentity = errors.New("Main device-authentication identity is corrupt; explicit recovery is required.")

// MainIdentityQuerier is the frozen TS identity store's single-query port.
// Both the shared database.DB and its transaction Querier satisfy it.
type MainIdentityQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// MainIdentity is an opaque persisted signing identity. Protocol proof and
// public-identity DTOs remain the generated shared contracts' responsibility.
type MainIdentity struct {
	mainID string
	key    *IdentityKey
}

// persistedMainIdentity is the existing device_main_identity JSONB record from
// devices/mainIdentity.ts. It is private storage, never a transport DTO.
type persistedMainIdentity struct {
	MainID               string `json:"mainId"`
	PublicKey            string `json:"publicKey"`
	PrivateKey           string `json:"privateKey"`
	PublicKeyFingerprint string `json:"publicKeyFingerprint"`
}

// LoadOrCreateMainIdentity preserves the installation's authentication key
// across restarts. An atomic insert returns the winner when startups race;
// corrupt persisted state is returned as an error and is never replaced.
func LoadOrCreateMainIdentity(ctx context.Context, sql MainIdentityQuerier, mainID string) (*MainIdentity, error) {
	var installation string
	err := sql.QueryRow(ctx, "select id::text from application_installation where singleton=true").Scan(&installation)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && installation != mainID {
		return nil, domainerror.New("wrong_main", "Device access rejected: wrong_main", 403, nil)
	}
	if err != nil {
		return nil, err
	}
	var raw []byte
	err = sql.QueryRow(ctx, "select record from device_main_identity where main_id=$1", mainID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		raw, err = createMainIdentity(ctx, sql, mainID)
	}
	if err != nil {
		return nil, err
	}
	return restoreMainIdentity(raw, mainID)
}

func createMainIdentity(ctx context.Context, sql MainIdentityQuerier, mainID string) ([]byte, error) {
	key, err := GenerateIdentityKey()
	if err != nil {
		return nil, err
	}
	privateKey, err := key.PrivateKeyPEM()
	if err != nil {
		return nil, err
	}
	candidate, err := json.Marshal(persistedMainIdentity{
		MainID: mainID, PublicKey: key.PublicKey(), PrivateKey: privateKey,
		PublicKeyFingerprint: key.Fingerprint(),
	})
	if err != nil {
		return nil, err
	}
	var raw []byte
	err = sql.QueryRow(ctx, `insert into device_main_identity(main_id,record) values($1,$2)
		on conflict(main_id) do update set main_id=excluded.main_id returning record`, mainID, candidate).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCorruptMainIdentity
	}
	return raw, err
}

func restoreMainIdentity(raw []byte, mainID string) (*MainIdentity, error) {
	var stored persistedMainIdentity
	if json.Unmarshal(raw, &stored) != nil || stored.MainID != mainID {
		return nil, ErrCorruptMainIdentity
	}
	fingerprint, err := PublicKeyFingerprint(stored.PublicKey)
	if err != nil {
		return nil, err
	}
	if fingerprint != stored.PublicKeyFingerprint {
		return nil, ErrCorruptMainIdentity
	}
	key, err := ParseIdentityKey(stored.PrivateKey)
	if err != nil {
		return nil, err
	}
	if key.Fingerprint() != stored.PublicKeyFingerprint {
		return nil, ErrCorruptMainIdentity
	}
	return &MainIdentity{mainID: mainID, key: key}, nil
}

func (identity *MainIdentity) MainID() string {
	return identity.mainID
}

func (identity *MainIdentity) PublicKey() string {
	return identity.key.PublicKey()
}

func (identity *MainIdentity) Fingerprint() string {
	return identity.key.Fingerprint()
}

func (identity *MainIdentity) Sign(message []byte) ([]byte, error) {
	if identity == nil || identity.key == nil {
		return nil, ErrCorruptMainIdentity
	}
	return identity.key.Sign(message)
}
