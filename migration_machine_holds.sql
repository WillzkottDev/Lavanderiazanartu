PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machine_holds (
  machine_id TEXT PRIMARY KEY,
  resident_tower INTEGER NOT NULL CHECK (resident_tower IN (1,2)),
  apartment TEXT NOT NULL,
  owner_client_hash TEXT NOT NULL,
  owner_ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(machine_id) REFERENCES machines(id)
);

CREATE INDEX IF NOT EXISTS idx_machine_holds_expires
ON machine_holds(expires_at);
