#!/usr/bin/env python3
"""Reports the last verified backup to the Notato monitor, which alerts when the report stops moving forward.

Run hourly from cron, separately from the backup schedule. It reads the backup configuration's root and instance
name and the backup status file, never their credentials, and sends only the verification time, size and image
count of the last recovery point. Nothing it sends or prints contains a credential, path, snapshot ID or customer
data. Only Python's standard library is needed.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request


class Failure(Exception):
    """An operator-safe error code, never a response body or path."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Failure("monitor_redirect_refused")


def private(path, code):
    # The same rule as backupctl's: a regular file of ours that nobody else can read or change.
    try:
        info = path.lstat()
    except OSError:
        raise Failure(code) from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Failure(code)
    return path


def monitor_url(value):
    url = urllib.parse.urlsplit(value)
    loopback = url.scheme == "http" and url.hostname in ["127.0.0.1", "localhost"]
    if (url.scheme != "https" and not loopback) or url.username or url.password or url.query or url.fragment:
        raise Failure("monitor_url_must_be_https")
    return value


def report(config_path):
    config = json.loads(private(config_path, "unsafe_backup_configuration").read_text())
    instance = config.get("instance")
    status = json.loads(private(Path(config["root"]) / "status.json", "unsafe_or_missing_status_file").read_text())
    success = status.get("last_success")
    if status.get("format") != 1 or status.get("instance") != instance or not isinstance(success, dict):
        raise Failure("no_verified_backup_recorded")
    try:
        verified = dt.datetime.fromisoformat(success["verified_at"])
    except (KeyError, TypeError, ValueError):
        raise Failure("no_verified_backup_recorded") from None
    if verified.tzinfo is None:
        raise Failure("no_verified_backup_recorded")
    counts = [success.get("bytes"), success.get("images")]
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in counts):
        raise Failure("no_verified_backup_recorded")
    return {"instance": instance, "verified_at": verified.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "bytes": counts[0], "images": counts[1]}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="the backup configuration (config.json)")
    parser.add_argument("--url", required=True, help="https://<monitor>/backup-heartbeat")
    parser.add_argument("--token-file", type=Path, required=True, help="a private file holding the heartbeat token")
    args = parser.parse_args()
    try:
        url = monitor_url(args.url)
        token = private(args.token_file, "unsafe_or_missing_token_file").read_text().strip()
        if len(token) < 32 or any(c.isspace() for c in token):
            raise Failure("invalid_heartbeat_token")
        body = report(args.config)
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "NotatoBackup/1.0"})
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
                accepted = response.status == 204
        except urllib.error.HTTPError:
            accepted = False
        if not accepted:
            raise Failure("heartbeat_not_accepted")
        print("Notato backup heartbeat accepted: last verified " + body["verified_at"] + ".")
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, Failure) else "heartbeat_failed"
        print("Notato backup heartbeat: " + code, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
