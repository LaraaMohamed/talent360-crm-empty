#!/usr/bin/env bash
#
# Provisions the CRM on one Compute Engine VM in Doha (me-central1).
#
#   bash deploy/provision.sh                # print what it would create
#   bash deploy/provision.sh --apply        # create it
#
# ── WHY A VM AND NOT CLOUD RUN ──────────────────────────────────────────────
#
# The CRM keeps its data in a single SQLite file and writes generated documents
# to a real directory. Cloud Run gives every instance an EPHEMERAL filesystem:
# the database would be lost on each restart and never shared between instances,
# and so would every contract in data/storage. Firebase Hosting cannot rewrite to
# a VM either — it only proxies Cloud Run and Cloud Functions — so this
# deployment does not involve Firebase at all.
#
# Moving to Cloud Run means moving to Cloud SQL first, which means converting 350
# synchronous database calls across 39 files to async. That is a project, not a
# deployment. See docs/07-operations.md.
#
# ── WHAT THIS CREATES, AND WHAT IT COSTS ────────────────────────────────────
#
#   1 e2-small VM              me-central1-a     ~$14/mo
#   1 30GB balanced PD         me-central1-a     ~$4/mo   (data + documents)
#   1 static external IP       me-central1       ~$3/mo
#   1 Cloud Storage bucket     ME-CENTRAL1       pennies  (backups)
#
# Everything is pinned to Doha. Nothing here is free tier, and nothing here is
# reversible by this script — it creates, it never deletes.
set -euo pipefail

PROJECT="${CRM_GCP_PROJECT:-talent360crm-v1}"
REGION="me-central1"            # Doha, Qatar
ZONE="${REGION}-a"
VM="crm"
DISK="crm-data"
BUCKET="${PROJECT}-crm-backups"
ADDRESS="crm-ip"
MACHINE="e2-small"              # 2 vCPU burst, 2GB. Sized for 5-30 users.

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

say() { printf '  %s\n' "$*"; }
run() {
    if [[ $APPLY -eq 1 ]]; then
        echo "+ $*"
        "$@"
    else
        echo "  would run: $*"
    fi
}

command -v gcloud >/dev/null 2>&1 || {
    echo "gcloud is not installed. https://cloud.google.com/sdk/docs/install" >&2
    exit 1
}

echo
say "project  ${PROJECT}"
say "region   ${REGION}  (Doha, Qatar)"
say "zone     ${ZONE}"
echo

run gcloud config set project "${PROJECT}"

# --- APIs -------------------------------------------------------------------
run gcloud services enable compute.googleapis.com storage.googleapis.com

# --- backups bucket, in Doha ------------------------------------------------
# Regional, not multi-region: a backup that silently replicates to another
# continent is not what "keep it in Doha" meant.
run gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT}" \
    --location="${REGION}" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access

# Backups are the last copy of a customer database. Deleting one should take
# more than a typo, and 90 days of versions is cheap next to losing it.
run gcloud storage buckets update "gs://${BUCKET}" --versioning
run gcloud storage buckets update "gs://${BUCKET}" \
    --lifecycle-file=deploy/bucket-lifecycle.json

# --- a static IP, so DNS does not move underneath you -----------------------
run gcloud compute addresses create "${ADDRESS}" --region="${REGION}"

# --- the data disk, separate from the boot disk -----------------------------
# Deliberately its own disk: the VM can be rebuilt, resized or replaced without
# going anywhere near the database, and a snapshot schedule on it is a snapshot
# schedule on exactly the thing that matters.
run gcloud compute disks create "${DISK}" \
    --zone="${ZONE}" --size=30GB --type=pd-balanced

run gcloud compute resource-policies create snapshot-schedule crm-daily \
    --region="${REGION}" \
    --max-retention-days=30 \
    --daily-schedule --start-time=22:00 \
    --on-source-disk-delete=keep-auto-snapshots

run gcloud compute disks add-resource-policies "${DISK}" \
    --zone="${ZONE}" --resource-policies=crm-daily

# --- the VM -----------------------------------------------------------------
# The service account gets object write on the backup bucket and nothing else.
run gcloud compute instances create "${VM}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE}" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=20GB --boot-disk-type=pd-balanced \
    --disk="name=${DISK},device-name=${DISK},mode=rw,auto-delete=no" \
    --address="${ADDRESS}" \
    --scopes=https://www.googleapis.com/auth/devstorage.read_write \
    --tags=https-server \
    --metadata-from-file=startup-script=deploy/startup.sh

# --- firewall ---------------------------------------------------------------
# 443 only. The app itself stays on 127.0.0.1:5180 and is never exposed; nginx
# is the only thing that can reach it. Port 80 is open solely so certbot can
# answer the ACME challenge, and nginx redirects it.
run gcloud compute firewall-rules create crm-allow-https \
    --allow=tcp:443,tcp:80 --target-tags=https-server \
    --description="CRM: TLS in, and ACME on 80. The app port is never exposed."

echo
if [[ $APPLY -eq 0 ]]; then
    say "Dry run. Re-run with --apply to create these."
else
    say "Created. Next:"
    say "  1. point crm.<your-domain> at the static IP:"
    say "     gcloud compute addresses describe ${ADDRESS} --region=${REGION} --format='value(address)'"
    say "  2. gcloud compute ssh ${VM} --zone=${ZONE}"
    say "  3. follow deploy/README.md from 'On the VM'"
fi
echo
