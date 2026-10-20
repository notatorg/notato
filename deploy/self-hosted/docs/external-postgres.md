# Use your own Postgres

Notato keeps its records and its sign-in tables in one Postgres database. If you already run Postgres, point Notato at it and skip the bundled one. It needs no extensions, so managed Postgres (RDS, Cloud SQL, Neon, Supabase, a Hetzner or DigitalOcean database) works as well as your own server. It was tested on Postgres 15 and 17.

## 1. Create a database and a role

Use a dedicated database that the role owns. Notato creates its own `notato` schema and the sign-in tables (`notato_auth_*`) when it starts, and changes them when you upgrade, so the role keeps the right to create and alter tables.

```sql
CREATE ROLE notato LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE notato OWNER notato;
```

## 2. Point Notato at it

In `.env`, remove `db` from `COMPOSE_PROFILES` (so the bundled Postgres does not start) and set the connection:

```sh
COMPOSE_PROFILES=storage,mail
NOTATO_DATABASE_URL=postgres://notato:a-long-random-password@db.example.com:5432/notato
NOTATO_DATABASE_SSL=verify-full
```

Percent-encode any `@`, `:`, `/` or `%` in the password. `NOTATO_POSTGRES_PASSWORD` is no longer used. Start as usual:

```sh
docker compose --env-file .env up -d
```

## 3. TLS

Notato verifies the database's TLS certificate by default (`verify-full`). Pick the line that fits:

| Your database | Set |
| --- | --- |
| A managed service, or a certificate from a public authority | `NOTATO_DATABASE_SSL=verify-full` (the default) |
| Your own certificate authority | `verify-full`, plus `NOTATO_DATABASE_CA_FILE=/certs/ca.pem`, mounted with [`examples/compose.ca-file.yml`](../examples/compose.ca-file.yml) |
| No TLS, on a network you trust (the same host, a private Docker network, a home LAN) | `NOTATO_DATABASE_SSL=disable` |

Without TLS and without `disable`, the server stops with "The server does not support SSL connections" and says what to set. Do not use `disable` across the internet.

## 4. Reaching it from the container

- **Another machine.** Use its address or DNS name in the URL. Allow the Docker host in `pg_hba.conf` and your firewall.
- **A container on this host.** Put Notato on its Docker network with [`examples/compose.existing-network.yml`](../examples/compose.existing-network.yml) and use the container's name as the host:

  ```sh
  docker compose -f compose.yml -f examples/compose.existing-network.yml --env-file .env up -d
  ```

- **Postgres installed on this host (not in Docker).** Docker Desktop and Colima resolve `host.docker.internal` to the host. On Linux add it to the server service (`extra_hosts: ["host.docker.internal:host-gateway"]`) and let Postgres listen on the Docker bridge address (`listen_addresses`, and an entry in `pg_hba.conf`).

## Things to know

- **Connection poolers.** Notato takes a session-level advisory lock while it starts. Connect directly, or through a pooler in **session** mode. Transaction-mode pooling (PgBouncer's default on many hosts, and the pooled ports of some managed services) breaks those locks.
- **Connections.** Notato keeps its connection pools small, a few connections per process, so a small connection limit is enough.
- **Backups.** Dump the database with the tools you already use, for example `pg_dump -Fc "$NOTATO_DATABASE_URL" > notato.dump`. See [Backups and recovery](../README.md#backups-and-recovery). Your database's own snapshots work too, if they are consistent with the screenshot bucket's contents (see below).
- **Moving from the bundled Postgres.** Stop the server, `pg_dump -Fc` from the bundled one, `pg_restore --no-owner` into the new database, then start Notato with the new URL and the same `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY`.
- **Checking the settings.** `notato-server preflight --env <file>` checks them offline without printing secrets. If the server will not start, `docker compose logs server` says why.
