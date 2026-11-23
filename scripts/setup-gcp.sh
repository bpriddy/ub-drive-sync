#!/usr/bin/env bash
###############################################################################
# setup-gcp.sh  (gub-drive-sync)
#
# One-time GCP provisioning for the Drive sync Cloud Run JOB.
# Idempotent — safe to re-run; existing resources are skipped.
#
# Assumes gcp-universal-backend's setup-gcp.sh + setup-cloud-sql.sh have
# already run (they provision the shared Cloud SQL instance + the
# <env>-database-url secrets this Job copies from).
#
# Usage:
#   ./scripts/setup-gcp.sh <project-id> <region>
#
# This script also creates two job-scoped IAM bindings that can't be made
# until the Job itself exists — so on a fresh project, expect a graceful
# "Job does not exist yet" line and re-run the script after the first
# Cloud Build deploy:
#
#   1. gub-admin SA  → roles/run.developer on this Job  (lets Sync button
#                                                       fire it).
#   2. Job's own SA  → roles/run.developer on this Job  (lets the runner
#                                                       self-trigger a
#                                                       continuation
#                                                       execution at a
#                                                       chunk boundary).
###############################################################################
set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <project-id> <region>}"
REGION="${2:?Usage: $0 <project-id> <region>}"
AR_REPO="gub-drive-sync"
REPO_OWNER="bpriddy"
REPO_NAME="gub-drive-sync"
ENVS=("dev" "staging" "prod")

echo "Setting up gub-drive-sync GCP resources in $PROJECT_ID / $REGION"
echo ""
gcloud config set project "$PROJECT_ID"

# ── Enable required APIs ─────────────────────────────────────────────────────
echo "→ Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  cloudscheduler.googleapis.com

# ── Artifact Registry repository ─────────────────────────────────────────────
echo "→ Creating Artifact Registry repository: $AR_REPO..."
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="gub-drive-sync container images" \
  2>/dev/null || echo "   (already exists, skipping)"

JOB_BIND_FAILED=0

# ── Per-environment resources ────────────────────────────────────────────────
for ENV in "${ENVS[@]}"; do
  JOB="gub-drive-sync-$ENV"
  SA_NAME="sa-$JOB"
  SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  # The gub-admin runtime SA fires the Job from its Sync button (human
  # behind IAP → Admin API call → Job).
  ADMIN_SA="sa-gub-admin-$ENV@$PROJECT_ID.iam.gserviceaccount.com"
  # The Cloud Scheduler poll job (defined in gcp-universal-backend's
  # terraform/drive_poll.tf) fires the Job for the poll mode. It uses the
  # backend's runtime SA today as its OIDC identity; once retargeted to
  # the Admin API it needs roles/run.invoker (or developer) on this Job.
  SCHEDULER_SA="sa-gcp-universal-backend-$ENV@$PROJECT_ID.iam.gserviceaccount.com"

  echo ""
  echo "── Environment: $ENV ─────────────────────────────────────────────────"

  echo "→ Creating service account: $SA_NAME..."
  if gcloud iam service-accounts create "$SA_NAME" \
       --display-name="gub-drive-sync $ENV runtime" \
       2>/dev/null; then
    echo "   waiting for IAM to see the new SA..."
    until gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; do
      sleep 2
    done
  else
    echo "   (already exists, skipping)"
  fi

  echo "→ Granting runtime IAM roles to $SA_NAME..."
  for ROLE in \
    roles/secretmanager.secretAccessor \
    roles/cloudtrace.agent \
    roles/logging.logWriter \
    roles/monitoring.metricWriter \
    roles/cloudsql.client; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_EMAIL" \
      --role="$ROLE" \
      --quiet
  done

  echo "→ Creating Secret Manager secrets for $ENV..."
  for SECRET in \
    "gub-drive-sync-db-url-$ENV" \
    "gub-drive-sync-bot-oauth-client-id-$ENV" \
    "gub-drive-sync-bot-oauth-client-secret-$ENV" \
    "gub-drive-sync-gemini-api-key-$ENV" \
    "gub-drive-sync-mailgun-api-key-$ENV"; do
    gcloud secrets create "$SECRET" \
      --replication-policy=automatic \
      2>/dev/null || echo "   (secret $SECRET already exists, skipping)"
  done

  # ── Job-scoped IAM (can't be created until the Job exists) ───────────────
  # These bindings target the Job resource itself. roles/run.developer
  # includes run.jobs.run — scoped to the job (not the project) keeps
  # the grant tight.

  # (a) gub-admin SA → run.developer on Job (Sync button trigger).
  echo "→ Binding $ADMIN_SA as run.developer on job $JOB..."
  if gcloud run jobs add-iam-policy-binding "$JOB" \
       --region="$REGION" \
       --member="serviceAccount:$ADMIN_SA" \
       --role="roles/run.developer" \
       --quiet 2>/dev/null; then
    echo "   bound."
  else
    echo "   (job $JOB does not exist yet — re-run after first deploy)"
    JOB_BIND_FAILED=1
  fi

  # (b) Job's own SA → run.developer on the SAME Job (self-trigger for
  #     chunked-sync continuation).
  echo "→ Binding $SA_EMAIL as run.developer on job $JOB (self-trigger)..."
  if gcloud run jobs add-iam-policy-binding "$JOB" \
       --region="$REGION" \
       --member="serviceAccount:$SA_EMAIL" \
       --role="roles/run.developer" \
       --quiet 2>/dev/null; then
    echo "   bound."
  else
    echo "   (job $JOB does not exist yet — re-run after first deploy)"
    JOB_BIND_FAILED=1
  fi

  # (c) gcp-universal-backend's runtime SA → run.invoker on the Job.
  #     Cloud Scheduler authenticates as this SA (OIDC) to fire the poll
  #     mode after terraform/drive_poll.tf is retargeted from HTTP→GUB to
  #     Admin-API→Job. We only need invoker for this caller (Scheduler
  #     never modifies the Job).
  echo "→ Binding $SCHEDULER_SA as run.invoker on job $JOB (scheduler poll)..."
  if gcloud run jobs add-iam-policy-binding "$JOB" \
       --region="$REGION" \
       --member="serviceAccount:$SCHEDULER_SA" \
       --role="roles/run.invoker" \
       --quiet 2>/dev/null; then
    echo "   bound."
  else
    echo "   (job $JOB does not exist yet — re-run after first deploy)"
    JOB_BIND_FAILED=1
  fi
done

# ── Casting job (casting staffing maintenance, docs/casting-pipeline.md §7) ──
# Provisioned deliberately here, because the Deploy workflow only UPDATES it
# and never creates it. Only for the live environment: os-test-491819 is UB
# production and keeps the -dev names (D37). The job starts as an inert shell:
# a public placeholder image, no CASTING_JOB_ACCOUNT_IDS (job-main refuses to
# run without it), CASTING_JOB_APPLY=false and no CASTING_T3_* variables, so
# the paid stage is impossible. It runs under the drive-sync runtime SA (it
# needs only Cloud SQL and the database URL secret, which that SA already has).
# No trigger and no scheduler: executions are started by hand until the
# schedule and any T3 budget are approved.
CASTING_ENV="dev"
CASTING_JOB="gub-drive-sync-casting-$CASTING_ENV"
echo ""
echo "→ Creating casting job $CASTING_JOB (inert shell)..."
if gcloud run jobs describe "$CASTING_JOB" --region="$REGION" >/dev/null 2>&1; then
  echo "   (already exists, skipping)"
else
  gcloud run jobs create "$CASTING_JOB" \
    --region="$REGION" \
    --image="us-docker.pkg.dev/cloudrun/container/job:latest" \
    --service-account="sa-gub-drive-sync-$CASTING_ENV@$PROJECT_ID.iam.gserviceaccount.com" \
    --set-cloudsql-instances="$PROJECT_ID:$REGION:gub-platform" \
    --set-env-vars="NODE_ENV=production,CASTING_JOB_APPLY=false" \
    --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=3600s \
    --memory=2Gi --cpu=1 \
    --quiet
  echo "   created. The next Deploy of this repo puts the real image and command on it."
fi

# ── Cloud Build service account permissions ──────────────────────────────────
echo ""
echo "── Cloud Build permissions ───────────────────────────────────────────────"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

echo "→ Granting Cloud Build SA permissions..."
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor \
  roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$CB_SA" \
    --role="$ROLE" \
    --quiet
done

# ── Deploys ──────────────────────────────────────────────────────────────────
# Deploys run from GitHub Actions (.github/workflows/deploy.yml), not Cloud
# Build: the dev trigger was retired at the CD cutover (2026-08-28) and its
# config, cloudbuild/dev.yaml, removed. No trigger is created here; set the
# repository secrets listed in the workflow header instead.
TRIGGER_FAILED=0

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================="
if [ "$TRIGGER_FAILED" -eq 1 ]; then
  echo "  gub-drive-sync setup PARTIALLY complete."
  echo ""
  echo "  Trigger creation failed — usually the GitHub repo isn't connected"
  echo "  to Cloud Build yet. Connect it, then RE-RUN this script. Everything"
  echo "  else is idempotent and will be skipped on the re-run."
  echo "    https://console.cloud.google.com/cloud-build/triggers/connect"
else
  echo "  gub-drive-sync setup complete."
fi
echo ""
echo "  Next steps:"
echo ""
echo "  1. Connect the GitHub repo to Cloud Build if not already (browser):"
echo "     https://console.cloud.google.com/cloud-build/triggers/connect"
echo "     → select $REPO_OWNER/$REPO_NAME"
echo ""
echo "  2. Populate the secrets per env:"
echo ""
echo "     # Reuse the shared GUB DB URL"
echo "     for ENV in dev staging prod; do"
echo "       gcloud secrets versions access latest --secret=\"\${ENV}-database-url\" \\"
echo "         | gcloud secrets versions add \"gub-drive-sync-db-url-\${ENV}\" --data-file=-"
echo "     done"
echo ""
echo "     # Bot-OAuth client (SAME client gub-admin uses for the consent flow)"
echo "     for ENV in dev staging prod; do"
echo "       gcloud secrets versions access latest --secret=\"gub-admin-bot-oauth-client-id-\${ENV}\" \\"
echo "         | gcloud secrets versions add \"gub-drive-sync-bot-oauth-client-id-\${ENV}\" --data-file=-"
echo "       gcloud secrets versions access latest --secret=\"gub-admin-bot-oauth-client-secret-\${ENV}\" \\"
echo "         | gcloud secrets versions add \"gub-drive-sync-bot-oauth-client-secret-\${ENV}\" --data-file=-"
echo "     done"
echo ""
echo "     # Gemini key (optional in dev — without it, the LLM falls back to"
echo "     # a mock driver that returns empty observations)"
echo "     printf '%s' '<gemini-api-key>' \\"
echo "       | gcloud secrets versions add gub-drive-sync-gemini-api-key-<env> --data-file=-"
echo ""
echo "     # Mailgun key (optional in dev — without it, MAIL_DRIVER=console"
echo "     # logs to stdout instead of dispatching)"
echo "     printf '%s' '<mailgun-api-key>' \\"
echo "       | gcloud secrets versions add gub-drive-sync-mailgun-api-key-<env> --data-file=-"
echo ""
echo "  3. Push to main to trigger the first deploy (creates the Job)."
echo ""
if [ "$JOB_BIND_FAILED" -eq 1 ]; then
  echo "  4. RE-RUN THIS SCRIPT after the first deploy — three job-scoped"
  echo "     IAM bindings can't be created until the Job exists:"
  echo "       - sa-gub-admin-<env>          → run.developer  (Sync button)"
  echo "       - sa-gub-drive-sync-<env>     → run.developer  (self-trigger)"
  echo "       - sa-gcp-universal-backend... → run.invoker    (poll scheduler)"
  echo ""
fi
echo "  5. Retarget the Cloud Scheduler poll job:"
echo "     The drive-poll-<env> Cloud Scheduler job is defined in"
echo "     gcp-universal-backend/terraform/drive_poll.tf. Apply the updated"
echo "     terraform (separate workstream — see that file for the new"
echo "     http_target uri pointing at the Admin API)."
echo ""
echo "  6. Update gub-admin env: add DRIVE_SYNC_JOB_NAME=gub-drive-sync-<env>"
echo "     so its Sync button fires the right Job. See gub-admin/cloudbuild/"
echo "     <env>.yaml."
echo "========================================================================="
