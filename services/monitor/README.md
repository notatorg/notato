# Independent monitoring

Run `bun services/monitor/src/main.ts` on a separate machine to detect an offline application host. The runner needs no provider account: it stores state in a private directory and sends alerts using the server's standard SMTP adapter. The optional `worker.ts` adapter also supports Cloudflare Workers and an explicitly configured Resend integration.

Set `NOTATO_MONITOR_TARGET` to the instance's HTTPS origin, `NOTATO_MONITOR_INSTANCE` to its label, `NOTATO_MONITOR_DIR` to a persistent directory, and `NOTATO_MONITORING_TOKEN` to the same random token configured on the server. Set `NOTATO_ALERT_TO` and the usual `NOTATO_SMTP_*` and `NOTATO_EMAIL_FROM` settings. Checks run every five minutes, including readiness, errors, disk usage, image transfers, retention workers and backup freshness. Capacity thresholds are configurable; they do not limit product features.

A backup job can POST its verified recovery point to `/backup-heartbeat` on port 4803. Configure a separate `NOTATO_BACKUP_HEARTBEAT_TOKEN`, expose that endpoint through HTTPS, and preserve the monitoring state directory. Alert history, deduplication, daily mail limits and weekly summaries survive restarts.

The optional Cloudflare configuration is an example; supply your own KV binding and domain before using it. Cloudflare and Resend are not required by the runner or by Notato.
