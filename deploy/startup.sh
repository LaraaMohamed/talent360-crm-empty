#!/usr/bin/env bash
#
# Runs once on the VM, as root, at first boot. Attached by provision.sh as the
# instance's startup-script.
#
# It prepares the machine and stops. It deliberately does NOT clone the repo or
# start the app: pulling code and a customer database onto a host is a decision a
# person makes, and a startup script that does it silently is a startup script
# that will one day do it to the wrong machine.
set -euo pipefail

DATA_DISK=/dev/disk/by-id/google-crm-data
MOUNT=/srv/crm-data

# --- Node 22, for node:sqlite ------------------------------------------------
# The whole app depends on node:sqlite, which is 22.5+. Debian 12's own nodejs
# package is far older, and the failure would be a confusing import error rather
# than an obvious version problem.
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

apt-get update
apt-get install -y nginx certbot python3-certbot-nginx git

# --- the data disk -----------------------------------------------------------
# Formatted only if it has no filesystem. Re-running this must never reformat a
# disk that already holds the database.
if ! blkid "${DATA_DISK}" >/dev/null 2>&1; then
    mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "${DATA_DISK}"
fi

mkdir -p "${MOUNT}"
grep -q "${MOUNT}" /etc/fstab || \
    echo "UUID=$(blkid -s UUID -o value ${DATA_DISK}) ${MOUNT} ext4 discard,defaults,nofail 0 2" >> /etc/fstab
mount -a

# --- the service account it runs as -----------------------------------------
# Not root, and no login shell. It owns the data and nothing else on the box.
id -u crm >/dev/null 2>&1 || useradd --system --home /srv/crm --shell /usr/sbin/nologin crm
mkdir -p /srv/crm "${MOUNT}/db" "${MOUNT}/storage" "${MOUNT}/backups"
chown -R crm:crm /srv/crm "${MOUNT}"
chmod 750 "${MOUNT}"

echo "startup-script finished. Follow deploy/README.md from 'On the VM'."
