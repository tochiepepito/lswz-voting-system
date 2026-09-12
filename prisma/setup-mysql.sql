-- ---------------------------------------------------------------------------
-- Game Event Voting System - one-time MySQL setup
--
-- Run this ONCE in MySQL Workbench, connected as root (or any account with
-- CREATE USER and GRANT privileges).
--
-- It creates:
--   * the application database
--   * a separate test database (the integration suite TRUNCATES tables, so it
--     must never share a database with real election data)
--   * a dedicated `voting` account with rights over both and nothing else
--
-- It does NOT create tables. Prisma Migrate does that:  npm run db:migrate
-- ---------------------------------------------------------------------------


-- 1. Databases -------------------------------------------------------------
--
-- utf8mb4 is not optional. MySQL's older `utf8` is only three bytes per
-- character and cannot store astral-plane characters, which appear in real
-- player names. A name that fails to store is a voter who cannot vote.

CREATE DATABASE IF NOT EXISTS voting_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE DATABASE IF NOT EXISTS voting_system_test
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;


-- 2. Application account ---------------------------------------------------
--
-- Change 'voting' to a real password for anything beyond local development,
-- and update DATABASE_URL in .env to match.
--
-- 'voting'@'localhost' restricts the account to connections from this machine.
-- Use 'voting'@'%' only if the database is on a different host from the app.

CREATE USER IF NOT EXISTS 'voting'@'localhost'
  IDENTIFIED BY 'voting';

-- Rights are granted per database, not globally: a compromised application
-- account cannot touch anything else on this server.
GRANT ALL PRIVILEGES ON voting_system.*      TO 'voting'@'localhost';
GRANT ALL PRIVILEGES ON voting_system_test.* TO 'voting'@'localhost';


-- 2b. Shadow database rights (development only) ----------------------------
--
-- `prisma migrate dev` builds a temporary "shadow" database to detect drift
-- between the migration history and the schema. It names each one randomly
-- (prisma_migrate_shadow_db_<uuid>), so the grant has to cover a pattern.
--
-- MySQL supports wildcards in the database part of a GRANT, which lets Prisma
-- create exactly these and nothing else - far better than handing the
-- application account a global CREATE DATABASE privilege.
--
-- The `\_` escapes matter: an unescaped `_` in a grant pattern is a
-- single-character wildcard, so `prisma_migrate...` would match much more than
-- intended. `\_` means a literal underscore.
--
-- SKIP THIS ON A PRODUCTION SERVER. Production applies pre-built migrations
-- with `npm run db:deploy`, which never needs a shadow database.

GRANT ALL PRIVILEGES ON `prisma\_migrate\_shadow\_db%`.* TO 'voting'@'localhost';

FLUSH PRIVILEGES;


-- 3. Verify ----------------------------------------------------------------

SELECT schema_name AS db, default_character_set_name AS charset, default_collation_name AS collation
FROM information_schema.schemata
WHERE schema_name IN ('voting_system', 'voting_system_test');

SHOW GRANTS FOR 'voting'@'localhost';


-- ---------------------------------------------------------------------------
-- Teardown, if you ever need to start clean. Destroys all voting data.
--
--   DROP DATABASE IF EXISTS voting_system;
--   DROP DATABASE IF EXISTS voting_system_test;
--   DROP USER IF EXISTS 'voting'@'localhost';
-- ---------------------------------------------------------------------------
