-- Ejecutar SOLO si ya habías creado la base con la versión anterior.
-- Si la base es nueva, basta con ejecutar schema.sql.

ALTER TABLE sessions ADD COLUMN owner_ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN pickup_until TEXT;

-- Compatibilidad para registros antiguos:
UPDATE sessions
SET owner_ip_hash = COALESCE(owner_ip_hash, 'legacy'),
    pickup_until = COALESCE(
      pickup_until,
      strftime('%Y-%m-%dT%H:%M:%fZ', datetime(ends_at, '+5 minutes'))
    );

CREATE INDEX IF NOT EXISTS idx_sessions_pickup
ON sessions(machine_id, pickup_until);
