# Upgrade the bundled PostgreSQL database

The Compose stack uses PostgreSQL 18.6. PostgreSQL 17 data files cannot be opened directly by PostgreSQL 18. The new image detects and refuses an old database, including an old volume mounted at the new parent directory. It does not migrate database files automatically.

Use a maintenance window and keep the previous checkout, image, settings and database volume until you have verified the new instance. Do not run `down --volumes` during this procedure. The [backup guide](../README.md#backups-and-recovery) covers screenshots and the encrypted copy of `.env` and its keys.

## Export from the running PostgreSQL 17 instance

Before switching checkouts, stop application writes and export the complete database. Run these commands from the old `deploy/self-hosted` directory, with a private backup directory you have already created:

```sh
docker compose --env-file .env stop server
docker compose --env-file .env exec -T postgres pg_dump -U notato -d notato -Fc > /private/backup/notato-postgres17.dump
docker compose --env-file .env down
```

Keep the matching object-store snapshot and encrypted deployment settings. Preserve the old Postgres volume: it is your rollback copy.

## Restore into a separate PostgreSQL 18 volume

Switch to the updated checkout. PostgreSQL 18 stores its database under `/var/lib/postgresql/18/docker`, and the Compose volume now mounts `/var/lib/postgresql`.

Create a private local override named `compose.postgres18.yml` beside `.env` to give the new database a different volume. Choose a unique name for this deployment; the example name below must not identify an existing volume:

```yaml
volumes:
    postgres-data:
        name: notato-postgres18-data
```

Use that override on every Compose command for this instance, including later upgrades:

```sh
docker compose -f compose.yml -f compose.postgres18.yml --env-file .env up -d --wait postgres
docker compose -f compose.yml -f compose.postgres18.yml --env-file .env exec -T postgres pg_restore -U notato -d notato --clean --if-exists --no-owner < /private/backup/notato-postgres17.dump
docker compose -f compose.yml -f compose.postgres18.yml --env-file .env up --build -d --wait
```

Check the server's health, sign in with the current account password, and open a note with a screenshot. Keep `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY` unchanged. Database roles managed by an external operator need their own role backup; these commands cover the bundled `notato` database and owner.

For rollback, stop the new stack and return to the old checkout and original Compose file, which uses the preserved PostgreSQL 17 volume. Restore the matching object snapshot if writes occurred on the new instance. Changes made after the migration are not present in the old database.

The local acceptance check for this upgrade verifies that PostgreSQL 18 refuses a PostgreSQL 17 volume without changing it and that a dump restored into a fresh PostgreSQL 18 volume preserves the test records. PostgreSQL's [major upgrade documentation](https://www.postgresql.org/docs/18/upgrading.html) describes alternatives such as `pg_upgrade` for larger installations.
