PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  tower INTEGER NOT NULL CHECK (tower IN (1,2)),
  type TEXT NOT NULL CHECK (type IN ('washer','dryer')),
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 3),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tower,type,number)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  tower INTEGER NOT NULL,
  apartment TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (45,90)),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  pickup_until TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','completed')),
  created_at TEXT NOT NULL,
  owner_ip_hash TEXT NOT NULL,
  FOREIGN KEY(machine_id) REFERENCES machines(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_machine
ON sessions(machine_id)
WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_sessions_apartment
ON sessions(tower, apartment, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_pickup
ON sessions(machine_id, pickup_until);

INSERT OR IGNORE INTO machines (id,tower,type,number) VALUES
('T1-W1',1,'washer',1),('T1-W2',1,'washer',2),('T1-W3',1,'washer',3),
('T1-D1',1,'dryer',1),('T1-D2',1,'dryer',2),('T1-D3',1,'dryer',3),
('T2-W1',2,'washer',1),('T2-W2',2,'washer',2),('T2-W3',2,'washer',3),
('T2-D1',2,'dryer',1),('T2-D2',2,'dryer',2),('T2-D3',2,'dryer',3);


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
