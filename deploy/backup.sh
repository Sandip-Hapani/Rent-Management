#!/bin/sh
# Nightly backup: compressed SQL dump + tarball of uploaded files, kept for $BACKUP_KEEP_DAYS days.
# Copy /backups off the server (rclone/restic to object storage) — see docs/04-operations.md.
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /backups
pg_dump --format=custom --no-owner --file="/backups/db-$STAMP.dump"
tar -czf "/backups/files-$STAMP.tar.gz" -C /files .
find /backups -type f -mtime +"${BACKUP_KEEP_DAYS:-30}" -delete
echo "[backup] $STAMP done"
