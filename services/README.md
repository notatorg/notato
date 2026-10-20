# Full Notato server

The full server is MIT, in the same repository as the SDKs and lightweight developer server. It adds required accounts, Postgres records, workspaces, collaboration, S3-compatible screenshots, integration connections, background workflows, pull-request reviews, retention and account data controls. All product features are available when self-hosting. Optional billing adapters remain available for a separately operated managed service.

| Component | Location | Responsibility |
| --- | --- | --- |
| Developer server | `packages/server`, `packages/cli` | Existing SQLite and file storage; fast local development and MCP loop |
| Full server | `services/server` | Postgres store, Better Auth, SMTP, S3, workspaces and integrations |
| Full board | `services/board` | Shared board plus accounts, workspaces, instance administration and integration management |
| Server command | `services/cli` | `notato-server serve`, `preflight`, `healthcheck` |
| Independent monitoring | `services/monitor` | Optional health, capacity, backup and SMTP monitoring |

Both servers use the same annotation APIs, board components, MCP implementation, SDKs and wire format. The developer server does not load Better Auth or require Postgres. There is no public/private submodule boundary in this repository.

See [self-hosting](../deploy/self-hosted/README.md) for Docker Compose, email, registration, authentication, backups and verification. Source package names retain `Cloud*` extension identifiers internally for compatibility; they do not impose a hosted service or a paid feature tier.

The board keeps project **Reviews** (testing sessions and GitHub PR feedback) separate from workspace **Integrations** and **Workspace settings**. Personal **Account** and **Appearance** controls live in the account menu; **Administration** requires explicit global permissions. See the [Reviews guide](../docs/reviews.md) and [navigation and permissions](../deploy/self-hosted/README.md#navigation-and-permissions).
