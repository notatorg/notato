# Self-hosting Notato

The full Notato server is MIT and runs without SaaS accounts. Docker Compose supplies the application, Postgres, [SeaweedFS](https://github.com/seaweedfs/seaweedfs#docker) for private S3-compatible screenshots, and [Mailpit](https://mailpit.axllent.org/docs/install/docker/) for a local email inbox. Integrations such as GitHub, Azure DevOps, Linear, Jira, Slack, Teams and webhooks remain available when explicitly configured. Collaboration, workspaces, workflows and reviews have no subscription requirement.

The existing `npx notato` developer loop remains on SQLite and local files. Use the full server when you need accounts and a shared instance. No existing developer database or hosted test database is migrated by these instructions.

## Choose your setup

One command brings up everything, and each bundled part can be swapped for something you already run. Which parts run is set by `COMPOSE_PROFILES` in `.env`: `db` is Postgres, `storage` is S3-compatible screenshot storage, `mail` is a mock inbox. Remove a profile and set that part's `NOTATO_*` settings to use your own.

| You have | Do this |
| --- | --- |
| Nothing yet | [Start locally](#start-locally): the whole stack, one command |
| A Postgres server (self-run or managed) | [Use your own Postgres](docs/external-postgres.md) |
| S3, Cloudflare R2, Backblaze B2 or another bucket | [Use your own screenshot storage](docs/object-storage.md) |
| An email provider or SMTP server | [Send real email](docs/email.md) |
| A domain you want people to reach over HTTPS | [Put Notato on the internet](docs/reverse-proxy.md): Caddy, nginx or a Cloudflare Tunnel |
| Postgres, storage or mail in another container | [`examples/compose.existing-network.yml`](examples/compose.existing-network.yml) joins their Docker network |
| A running instance and an app to connect | [Connect an app and an agent](docs/connect-an-app.md) |

Mix freely: your own Postgres with the bundled storage and mail is `COMPOSE_PROFILES=storage,mail` plus `NOTATO_DATABASE_URL`. With all three swapped, only the Notato container runs. `.env.example` lists every setting, and `examples/` holds the Compose add-ons.

## Start locally

From the repository root, with Bun and Docker Compose 2.24 or later installed:

```sh
bun deploy/self-hosted/init.ts --admin-email you@example.com
docker compose -f deploy/self-hosted/compose.yml --env-file deploy/self-hosted/.env up --build -d
```

Open **http://localhost:4799** and sign in with the configured administrator email and password. The initializer stores the generated password and keys in `deploy/self-hosted/.env`, with owner-only permissions. It prints no secrets and refuses to replace an existing file. View the password privately, or edit it before the first startup. Keep this file out of Git and backups that are not encrypted. `.env.example` documents settings if you prefer to provide your own values.

Open **http://localhost:8026** for the mock inbox (the `mail` profile). SMTP stays inside the Compose network. The database and S3 service expose no host ports. Application and inbox ports bind to loopback. If you change the application port, change both `NOTATO_HTTP_PORT` and `NOTATO_PUBLIC_URL`.

The application runs as a non-root user. Postgres, objects, the inbox and application state have separate persistent volumes. Stopping containers preserves data:

```sh
docker compose -f deploy/self-hosted/compose.yml --env-file deploy/self-hosted/.env down
```

Do not add `--volumes` unless you intend to delete that instance's data.

**Then:** change the generated administrator password under Settings → Account → Password, [connect an app and an agent](docs/connect-an-app.md), and when you want other people or real email, read [Send real email](docs/email.md) and [Put Notato on the internet](docs/reverse-proxy.md).

## Accounts and registration

Better Auth runs inside Notato, with identity tables in the same Postgres database as application records. Its API is `/api/auth`; no provider URL, browser API key, external identity service or CAPTCHA account is required. Browser sessions use HttpOnly cookies, and every application request revalidates the current identity session. Project app and MCP tokens retain their separate permissions and workspace scope.

On the first startup, `NOTATO_ADMIN_EMAIL` and `NOTATO_ADMIN_PASSWORD` create the protected instance administrator. Set `NOTATO_ADMIN_NAME` for its initial display name; the default is `Instance administrator`. Its identity is pinned by ID in Postgres and cannot be deleted, demoted or suspended through Notato. It also owns an ordinary workspace and can use the whole product. Subsequent startups preserve the account, name and password; changing bootstrap settings does not reset an existing account.

The generated password sits in plain text in `.env`, so **change it after your first sign-in** under **Settings → Account → Password**. Until you do, the board shows the administrator a reminder; it disappears once the password no longer matches the one in `.env`. Afterwards `NOTATO_ADMIN_PASSWORD` is only used if the database is created again, and you can remove it from the file. If you forget the password, use **Forgot password** on the sign-in page, which needs working SMTP.

Every account can change its own password under **Settings → Account → Password** with the current one (12–256 characters), with no email involved. "Sign out my other devices" is on by default. Every account, including the protected administrator, can change its display name under **Settings → Account → Profile**. Changes appear on the board and in collaborator lists. Names must contain 1–100 characters. Changing a name leaves the account ID, administrator role and workspace names unchanged.

Instance → Invitations sends account invitations through SMTP. Registered users can invite collaborators to workspaces and projects. Each invitation is bound to an email address and expiry; recipients choose a password and verify their address.

`NOTATO_SIGNUP_MODE` controls uninvited registration:

| Setting | Behaviour |
| --- | --- |
| `closed` (default) | Only valid account, workspace or project invitations permit new accounts |
| `allowlist` | Invitations plus addresses in `NOTATO_SIGNUP_ALLOWED_EMAILS` (comma-separated full addresses) |
| `open` | Public registration, with email verification |

The root administrator exists in every mode. Ordinary accounts cannot grant themselves an administrator role. Instance administrators can suspend and restore accounts; suspension immediately prevents personal token use as well as browser access. Users can revoke devices, reset passwords, and delete their own accounts using their current password, subject to workspace ownership checks. The protected administrator's deletion control is disabled.

Two-factor authentication is **optional per account** under Settings → Account. TOTP enrollment requires the current password and a valid authenticator code before activation. Save the recovery codes; each works once. Once enabled, future sign-ins must complete the second factor. Enabling public registration does not make MFA compulsory.

## Settings

Set these in `.env`. The initializer writes the secrets and the bundled-service values; everything else is optional. Blank values count as not set.

| Setting | Purpose |
| --- | --- |
| `COMPOSE_PROFILES` | Which bundled services run: `db`, `storage`, `mail` |
| `NOTATO_PUBLIC_URL` | The address people use, such as `https://notato.example.com`. Used for cookies, emails and origin checks |
| `NOTATO_HTTP_PORT`, `NOTATO_MAIL_PORT` | Host ports (loopback only) for the app and the mock inbox |
| `NOTATO_ADMIN_EMAIL`, `NOTATO_ADMIN_NAME`, `NOTATO_ADMIN_PASSWORD` | The protected administrator, created on first start |
| `NOTATO_AUTH_SECRET` | Stable random signing/encryption secret, at least 32 characters |
| `NOTATO_PLUGIN_KEY` | Stable 64-character hex key that encrypts integration credentials |
| `NOTATO_SIGNUP_MODE`, `NOTATO_SIGNUP_ALLOWED_EMAILS` | Who may register: see [Accounts](#accounts-and-registration) |
| `NOTATO_DATABASE_URL`, `NOTATO_DATABASE_SSL`, `NOTATO_DATABASE_CA_FILE` | Your own Postgres: [guide](docs/external-postgres.md). Default is the bundled one |
| `NOTATO_POSTGRES_PASSWORD` | The bundled Postgres's password |
| `NOTATO_S3_ENDPOINT`, `NOTATO_S3_REGION`, `NOTATO_S3_BUCKET`, `NOTATO_S3_FORCE_PATH_STYLE`, `NOTATO_S3_ACCESS_KEY_ID`, `NOTATO_S3_SECRET_ACCESS_KEY`, `NOTATO_BLOB_CACHE_MB` | Screenshot storage: [guide](docs/object-storage.md) |
| `NOTATO_SMTP_HOST`, `NOTATO_SMTP_PORT`, `NOTATO_SMTP_SECURE`, `NOTATO_SMTP_USER`, `NOTATO_SMTP_PASSWORD`, `NOTATO_EMAIL_FROM` | Email: [guide](docs/email.md) |
| `NOTATO_TRUST_PROXY` | `1` behind a proxy you control: [guide](docs/reverse-proxy.md) |
| `NOTATO_RESOURCE_LIMITS` | Optional JSON caps on notes, bytes, projects, workspaces, tokens and members |
| `NOTATO_IMAGE` | A published image to run instead of building from this checkout |

Screenshots are named by content hash, checked on read, and served only through Notato after project authorization. Keep the bucket private. Postgres holds no image bytes, and the database and object storage are independently replaceable. Resource limits are resource controls, not paid feature gates: by default there is no plan enforcement, monthly quota or one-workspace restriction, and billing stays off unless an operator configures it.

Add integration provider credentials through the board. Keep `NOTATO_PLUGIN_KEY` stable and keep a recovery copy: losing it makes saved credentials unreadable. GitHub, Azure DevOps and issue-tracker adapters, signed webhooks, personal feedback permissions, context assignment and review leases are all part of the server. Optional admissions and waitlist management use `NOTATO_BETA_ENABLED=1` (the instance administrator's email is the default admission administrator, or set `NOTATO_BETA_ADMIN_EMAILS`) and run in this board on this Postgres. [Independent monitoring](../../services/monitor/README.md) can run on a separate host and alert through SMTP.

## Backups and recovery

Back up the **whole Postgres database**, including Better Auth's `notato_auth_*` tables, `notato_instance`, invitations and the `notato` schema. Postgres exports alone do not contain screenshots. Back up the private S3 bucket and the deployment settings, especially `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY`, in encrypted storage with a separate recovery copy.

**With your own Postgres or storage**, use their tools instead of the commands below: `pg_dump` against your database ([notes](docs/external-postgres.md#things-to-know)), and your provider's versioning, replication or `rclone` for the bucket ([notes](docs/object-storage.md#backups)). The rule is unchanged: the database and the bucket must come from the same moment, and `.env` (above all `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY`) is saved in encrypted storage.

For the bundled stack, a simple single-host recovery point is: stop application and object writes, take a Postgres dump, and snapshot the object-store volume while it is stopped. Run these from this directory (the Compose project is named `notato`, so volumes are `notato_*` unless you pass `-p`; `docker volume ls` shows the volume names):

```sh
docker compose --env-file .env stop server
docker compose --env-file .env exec -T postgres pg_dump -U notato -d notato -Fc > /private/backup/notato.dump
docker compose --env-file .env stop objects
docker run --rm -v notato_object-data:/data:ro alpine tar czf - -C /data . > /private/backup/objects.tgz
docker compose --env-file .env start objects server
```

Streaming the archive through standard output needs no host folder to be shared with Docker, so it also works on Colima and Docker Desktop. Save `.env` in encrypted backup storage beside these files.

Restoring is the same in reverse, into empty volumes and with the **same** `.env` (so `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY` match). This sequence has been tested end to end, including a changed administrator password, a note and its screenshot:

```sh
docker compose --env-file .env down --volumes        # only when replacing a lost or broken instance
docker compose --env-file .env up -d --wait postgres objects
docker compose --env-file .env stop objects
docker run --rm -i -v notato_object-data:/data alpine sh -c 'rm -rf /data/* /data/.[!.]*; tar xzf - -C /data' < /private/backup/objects.tgz
docker compose --env-file .env start objects
docker compose --env-file .env exec -T postgres pg_restore -U notato -d notato --clean --if-exists --no-owner < /private/backup/notato.dump
docker compose --env-file .env up -d --wait
```

Sign in with your current password, not the one in `.env`, and open a note with a screenshot to confirm both halves came back. Restore Postgres and the matching object snapshot together, and keep writes stopped while you do. Change the canonical public origin for an isolated recovery drill. Use your storage system's consistent snapshot or replication procedure for larger deployments. The lightweight developer server's SQLite backup commands do not back up this system. Marketing-email withdrawals made after the dump are missing from a restored database: see `services/server/scripts/email-restore.ts` if you send marketing email.

## Upgrade and roll back

Releases publish two images: `ghcr.io/notatorg/notato` (the SQLite developer loop) and `ghcr.io/notatorg/notato-server` (this full server). Versions move together with the SDKs, so server 0.3 works with SDK 0.3. Read the [changelog](../../CHANGELOG.md) before upgrading.

1. **Back up first**, as in [Backups and recovery](#backups-and-recovery): Postgres, the object store and `.env`. This is also how you roll back.
2. Move to the new release. From a checkout, check out the release tag and rebuild; to run the published image instead, name it in `.env` and skip the build:

```sh
# from a checkout of the new tag
docker compose -f deploy/self-hosted/compose.yml --env-file deploy/self-hosted/.env up --build -d

# or, using the published image
echo 'NOTATO_IMAGE=ghcr.io/notatorg/notato-server:0.3.0' >> deploy/self-hosted/.env
docker compose -f deploy/self-hosted/compose.yml --env-file deploy/self-hosted/.env pull server
docker compose -f deploy/self-hosted/compose.yml --env-file deploy/self-hosted/.env up -d --no-build
```

3. The server migrates its own tables on startup (Notato's under the `notato` schema, with a recorded schema version, and Better Auth's `notato_auth_*` tables), under a lock, so several replicas starting together are safe. Check `docker compose ... logs server` and sign in.

Schema changes only move forward. A server that finds a database newer than itself refuses to start ("Postgres schema N is newer than this build; upgrade notato") instead of guessing, so **you cannot roll back by starting an older image on an upgraded database**. To roll back, stop the server, restore the pre-upgrade Postgres dump and object snapshot into the volumes, and start the previous image. Keep `NOTATO_AUTH_SECRET` and `NOTATO_PLUGIN_KEY` unchanged through every upgrade and restore.

## Development and verification

```sh
bun install --frozen-lockfile
bun run build:service
bun run typecheck
bun test services
```

Tests use disposable data, embedded Postgres and random HTTP ports. They do not use `.notato/`, port 4747 or configured provider accounts. To run the storage contract against a real disposable Postgres server, set `NOTATO_TEST_DATABASE_URL` to an administrator connection for that test server; the harness creates and drops separate test databases.

For a disposable local Compose stack, run the complete Postgres/authentication, S3 and SMTP acceptance check:

```sh
bun services/server/scripts/smoke-self-hosted.ts --env /private/test-stack.env --mailpit-url http://localhost:8026
```

It creates and removes a test project, verifies private screenshot storage, and sends an invitation to an `example.test` address in the mock inbox. Run it only against a disposable local instance. `notato-server preflight --env /private/resolved-service.env` checks settings offline and never prints values; use resolved application settings when checking a Compose deployment.
