#!/usr/bin/env bash
#
# Nightly: take a verified snapshot, then push it off the machine.
#
# `npm run backup` is the part that matters — it verifies the snapshot opens and
# has the rows it should before keeping it. This script exists only to get that
# verified snapshot into a bucket, because a backup on the same disk as the
# database is not a backup.
#
# Installed as a systemd timer; see deploy/crm-backup.timer.
set -euo pipefail

BUCKET="${CRM_BACKUP_BUCKET:?set CRM_BACKUP_BUCKET, e.g. talent360crm-v1-crm-backups}"
BACKUP_DIR="${CRM_BACKUP_DIR:-/srv/crm-data/backups}"

cd /srv/crm
CRM_DB=/srv/crm-data/db/crm.db \
CRM_STORAGE=/srv/crm-data/storage \
CRM_BACKUP_DIR="${BACKUP_DIR}" \
    /usr/bin/node backup-db.mjs

# Mirrors rather than copies, so the bucket follows CRM_BACKUP_KEEP's pruning.
# Object versioning on the bucket is what makes a mistaken delete recoverable —
# without it, `rsync -d` would happily propagate a local wipe.
gcloud storage rsync --recursive --delete-unmatched-destination-objects \
    "${BACKUP_DIR}" "gs://${BUCKET}/nightly"

echo "backup mirrored to gs://${BUCKET}/nightly"
