#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-azure-shadow.sh [plan|deploy]

Required environment:
  SCRUFFY_GH_APP_ID
  SCRUFFY_GH_APP_INSTALLATION_ID
  SCRUFFY_GH_APP_PRIVATE_KEY_FILE
  SCRUFFY_WEBHOOK_SECRET

Optional environment:
  AZURE_SUBSCRIPTION_ID             defaults to the active subscription
  AZURE_LOCATION                    defaults to swedencentral
  AZURE_RESOURCE_GROUP              defaults to ewi-sandboxes
  AZURE_ACR_RESOURCE_GROUP          defaults to ewi-sandboxes
  AZURE_ACR_NAME                    defaults to ewiautopodacr
  AZURE_ACR_PULL_IDENTITY           defaults to autopod-sandbox-acr-pull
  SCRUFFY_DB_ADMIN_PASSWORD         generated on first deployment; reused from Key Vault later
  SCRUFFY_POSTGRES_SKU              defaults to Standard_B1ms
  SCRUFFY_NIGHTLY_CADENCE_MS        defaults to 86400000 (24 hours)
  SCRUFFY_NIGHTLY_TICK_MS           defaults to 300000 (5 minutes)
  SCRUFFY_MODEL_BACKEND             fake (default) | azure
  AZURE_FOUNDRY_RESOURCE            existing Foundry resource name (azure only)
  AZURE_FOUNDRY_DEPLOYMENT          existing Claude deployment name (azure only)
  SCRUFFY_RELEASE_OIDC_AUDIENCE     defaults to scruffy-release
  SCRUFFY_RELEASE_OIDC_REPOSITORY   owner/repository (enables hosted release API)
  SCRUFFY_RELEASE_OIDC_REPOSITORY_ID
  SCRUFFY_RELEASE_OIDC_WORKFLOW_REF
  SCRUFFY_RELEASE_TARGET_ENVIRONMENT
  SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT
EOF
}

ACTION="${1:-plan}"
if [[ "$ACTION" != "plan" && "$ACTION" != "deploy" ]]; then
  usage >&2
  exit 2
fi

for command_name in az jq openssl npm git curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command not found: $command_name" >&2
    exit 1
  fi
done

required_env=(
  SCRUFFY_GH_APP_ID
  SCRUFFY_GH_APP_INSTALLATION_ID
  SCRUFFY_GH_APP_PRIVATE_KEY_FILE
  SCRUFFY_WEBHOOK_SECRET
)
for variable_name in "${required_env[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "$variable_name must be set" >&2
    usage >&2
    exit 1
  fi
done

if [[ ! "$SCRUFFY_GH_APP_ID" =~ ^[0-9]+$ ]]; then
  echo "SCRUFFY_GH_APP_ID must be numeric" >&2
  exit 1
fi
if [[ ! "$SCRUFFY_GH_APP_INSTALLATION_ID" =~ ^[0-9]+$ ]]; then
  echo "SCRUFFY_GH_APP_INSTALLATION_ID must be numeric" >&2
  exit 1
fi
if [[ ! -r "$SCRUFFY_GH_APP_PRIVATE_KEY_FILE" ]]; then
  echo "private key is not readable: $SCRUFFY_GH_APP_PRIVATE_KEY_FILE" >&2
  exit 1
fi
if ! grep -q -- '-----BEGIN.*PRIVATE KEY-----' "$SCRUFFY_GH_APP_PRIVATE_KEY_FILE"; then
  echo "SCRUFFY_GH_APP_PRIVATE_KEY_FILE does not contain a PEM private key" >&2
  exit 1
fi
if (( ${#SCRUFFY_WEBHOOK_SECRET} < 32 )); then
  echo "SCRUFFY_WEBHOOK_SECRET must contain at least 32 characters" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_ROOT/infra/azure/main.bicep"
SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
LOCATION="${AZURE_LOCATION:-swedencentral}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-ewi-sandboxes}"
ACR_RESOURCE_GROUP="${AZURE_ACR_RESOURCE_GROUP:-ewi-sandboxes}"
ACR_NAME="${AZURE_ACR_NAME:-ewiautopodacr}"
ACR_PULL_IDENTITY="${AZURE_ACR_PULL_IDENTITY:-autopod-sandbox-acr-pull}"
POSTGRES_SKU="${SCRUFFY_POSTGRES_SKU:-Standard_B1ms}"
NIGHTLY_CADENCE_MS="${SCRUFFY_NIGHTLY_CADENCE_MS:-86400000}"
NIGHTLY_TICK_MS="${SCRUFFY_NIGHTLY_TICK_MS:-300000}"
MODEL_BACKEND="${SCRUFFY_MODEL_BACKEND:-fake}"
FOUNDRY_RESOURCE="${AZURE_FOUNDRY_RESOURCE:-}"
FOUNDRY_DEPLOYMENT="${AZURE_FOUNDRY_DEPLOYMENT:-}"
RELEASE_OIDC_AUDIENCE="${SCRUFFY_RELEASE_OIDC_AUDIENCE:-scruffy-release}"
RELEASE_OIDC_REPOSITORY="${SCRUFFY_RELEASE_OIDC_REPOSITORY:-}"
RELEASE_OIDC_REPOSITORY_ID="${SCRUFFY_RELEASE_OIDC_REPOSITORY_ID:-}"
RELEASE_OIDC_WORKFLOW_REF="${SCRUFFY_RELEASE_OIDC_WORKFLOW_REF:-}"
RELEASE_TARGET_ENVIRONMENT="${SCRUFFY_RELEASE_TARGET_ENVIRONMENT:-}"
RELEASE_APPROVAL_ENVIRONMENT="${SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT:-}"
DEPLOYMENT_NAME="scruffy-shadow"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
ACR_LOGIN_SERVER="$(az acr show --subscription "$SUBSCRIPTION_ID" --resource-group "$ACR_RESOURCE_GROUP" --name "$ACR_NAME" --query loginServer -o tsv)"
IMAGE="$ACR_LOGIN_SERVER/scruffy:$GIT_SHA"
OPERATOR_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"

if [[ ! "$NIGHTLY_CADENCE_MS" =~ ^[1-9][0-9]*$ || ! "$NIGHTLY_TICK_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "SCRUFFY_NIGHTLY_CADENCE_MS and SCRUFFY_NIGHTLY_TICK_MS must be positive integers" >&2
  exit 1
fi
if (( NIGHTLY_TICK_MS >= NIGHTLY_CADENCE_MS )); then
  echo "SCRUFFY_NIGHTLY_TICK_MS must be shorter than SCRUFFY_NIGHTLY_CADENCE_MS" >&2
  exit 1
fi
if [[ "$MODEL_BACKEND" != "fake" && "$MODEL_BACKEND" != "azure" ]]; then
  echo "SCRUFFY_MODEL_BACKEND must be fake or azure" >&2
  exit 1
fi
if [[ "$MODEL_BACKEND" == "azure" && ( -z "$FOUNDRY_RESOURCE" || -z "$FOUNDRY_DEPLOYMENT" ) ]]; then
  echo "AZURE_FOUNDRY_RESOURCE and AZURE_FOUNDRY_DEPLOYMENT are required for the azure backend" >&2
  exit 1
fi
OIDC_VALUES=("$RELEASE_OIDC_REPOSITORY" "$RELEASE_OIDC_REPOSITORY_ID" "$RELEASE_OIDC_WORKFLOW_REF" "$RELEASE_TARGET_ENVIRONMENT" "$RELEASE_APPROVAL_ENVIRONMENT")
oidc_set=0
for value in "${OIDC_VALUES[@]}"; do [[ -n "$value" ]] && ((oidc_set+=1)); done
if (( oidc_set != 0 && oidc_set != 5 )); then
  echo "all SCRUFFY_RELEASE_OIDC_* identity fields and SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT must be set together" >&2
  exit 1
fi
if [[ -n "$RELEASE_OIDC_REPOSITORY_ID" && ! "$RELEASE_OIDC_REPOSITORY_ID" =~ ^[0-9]+$ ]]; then
  echo "SCRUFFY_RELEASE_OIDC_REPOSITORY_ID must be numeric" >&2
  exit 1
fi
if [[ -n "$RELEASE_TARGET_ENVIRONMENT" && ! "$RELEASE_TARGET_ENVIRONMENT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "SCRUFFY_RELEASE_TARGET_ENVIRONMENT is malformed" >&2
  exit 1
fi
if [[ -n "$RELEASE_OIDC_WORKFLOW_REF" && ! "$RELEASE_OIDC_WORKFLOW_REF" =~ ^[^/]+/[^/]+/.+\.ya?ml@[0-9a-f]{40}$ ]]; then
  echo "SCRUFFY_RELEASE_OIDC_WORKFLOW_REF must be pinned to a full commit SHA" >&2
  exit 1
fi

if [[ -z "$SUBSCRIPTION_ID" || -z "$OPERATOR_OBJECT_ID" || -z "$ACR_LOGIN_SERVER" ]]; then
  echo "could not resolve the active Azure subscription, operator, or registry" >&2
  exit 1
fi

az account set --subscription "$SUBSCRIPTION_ID"
az bicep build --file "$TEMPLATE" --stdout >/dev/null

POSTGRES_PASSWORD="${SCRUFFY_DB_ADMIN_PASSWORD:-}"
if [[ -z "$POSTGRES_PASSWORD" ]] && az group exists --subscription "$SUBSCRIPTION_ID" --name "$RESOURCE_GROUP" | grep -qx true; then
  EXISTING_VAULT="$(az deployment group show --subscription "$SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" --query properties.outputs.keyVaultName.value -o tsv 2>/dev/null || true)"
  if [[ -n "$EXISTING_VAULT" ]]; then
    POSTGRES_PASSWORD="$(az keyvault secret show --subscription "$SUBSCRIPTION_ID" --vault-name "$EXISTING_VAULT" --name postgres-admin-password --query value -o tsv 2>/dev/null || true)"
  fi
fi
if [[ -z "$POSTGRES_PASSWORD" ]]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
fi
if (( ${#POSTGRES_PASSWORD} < 16 )) || [[ ! "$POSTGRES_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "SCRUFFY_DB_ADMIN_PASSWORD must be at least 16 URL-safe characters ([A-Za-z0-9._~-])" >&2
  exit 1
fi

umask 077
PARAMETERS_FILE="$(mktemp "${TMPDIR:-/tmp}/scruffy-azure-parameters.XXXXXX.json")"
cleanup() {
  rm -f "$PARAMETERS_FILE"
}
trap cleanup EXIT

write_parameters() {
  local deploy_app="$1"
  jq -n \
    --arg location "$LOCATION" \
    --arg acrResourceGroupName "$ACR_RESOURCE_GROUP" \
    --arg acrName "$ACR_NAME" \
    --arg acrPullIdentityName "$ACR_PULL_IDENTITY" \
    --arg image "$IMAGE" \
    --arg githubAppId "$SCRUFFY_GH_APP_ID" \
    --arg githubInstallationId "$SCRUFFY_GH_APP_INSTALLATION_ID" \
    --arg githubPrivateKey "$(<"$SCRUFFY_GH_APP_PRIVATE_KEY_FILE")" \
    --arg webhookSecret "$SCRUFFY_WEBHOOK_SECRET" \
    --arg postgresAdminPassword "$POSTGRES_PASSWORD" \
    --arg postgresSkuName "$POSTGRES_SKU" \
    --arg nightlyCadenceMs "$NIGHTLY_CADENCE_MS" \
    --arg nightlyTickMs "$NIGHTLY_TICK_MS" \
    --arg modelBackend "$MODEL_BACKEND" \
    --arg foundryResourceName "$FOUNDRY_RESOURCE" \
    --arg foundryDeploymentName "$FOUNDRY_DEPLOYMENT" \
    --arg releaseOidcAudience "$RELEASE_OIDC_AUDIENCE" \
    --arg releaseOidcRepository "$RELEASE_OIDC_REPOSITORY" \
    --arg releaseOidcRepositoryId "$RELEASE_OIDC_REPOSITORY_ID" \
    --arg releaseOidcWorkflowRef "$RELEASE_OIDC_WORKFLOW_REF" \
    --arg releaseTargetEnvironment "$RELEASE_TARGET_ENVIRONMENT" \
    --arg releaseApprovalEnvironment "$RELEASE_APPROVAL_ENVIRONMENT" \
    --arg operatorObjectId "$OPERATOR_OBJECT_ID" \
    --argjson deployContainerApp "$deploy_app" \
    '{
      "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
      contentVersion: "1.0.0.0",
      parameters: {
        location: {value: $location},
        acrResourceGroupName: {value: $acrResourceGroupName},
        acrName: {value: $acrName},
        acrPullIdentityName: {value: $acrPullIdentityName},
        image: {value: $image},
        deployContainerApp: {value: $deployContainerApp},
        githubAppId: {value: $githubAppId},
        githubInstallationId: {value: $githubInstallationId},
        githubPrivateKey: {value: $githubPrivateKey},
        webhookSecret: {value: $webhookSecret},
        postgresAdminPassword: {value: $postgresAdminPassword},
        postgresSkuName: {value: $postgresSkuName},
        nightlyCadenceMs: {value: $nightlyCadenceMs},
        nightlyTickMs: {value: $nightlyTickMs},
        modelBackend: {value: $modelBackend},
        foundryResourceName: {value: $foundryResourceName},
        foundryDeploymentName: {value: $foundryDeploymentName},
        releaseOidcAudience: {value: $releaseOidcAudience},
        releaseOidcRepository: {value: $releaseOidcRepository},
        releaseOidcRepositoryId: {value: $releaseOidcRepositoryId},
        releaseOidcWorkflowRef: {value: $releaseOidcWorkflowRef},
        releaseTargetEnvironment: {value: $releaseTargetEnvironment},
        releaseApprovalEnvironment: {value: $releaseApprovalEnvironment},
        operatorObjectId: {value: $operatorObjectId}
      }
    }' >"$PARAMETERS_FILE"
}

if ! az group exists --subscription "$SUBSCRIPTION_ID" --name "$RESOURCE_GROUP" | grep -qx true; then
  echo "Creating resource group $RESOURCE_GROUP in $LOCATION"
  az group create --subscription "$SUBSCRIPTION_ID" --name "$RESOURCE_GROUP" --location "$LOCATION" \
    --tags application=scruffy authority=shadow-only environment=persistent-shadow >/dev/null
fi

write_parameters true
if [[ "$ACTION" == "plan" ]]; then
  echo "Planning $IMAGE in $RESOURCE_GROUP ($LOCATION)"
  az deployment group what-if \
    --subscription "$SUBSCRIPTION_ID" \
    --resource-group "$RESOURCE_GROUP" \
    --name "$DEPLOYMENT_NAME" \
    --template-file "$TEMPLATE" \
    --parameters "@$PARAMETERS_FILE"
  exit 0
fi

echo "Checking GitHub App installation access (read-only)"
SCRUFFY_GH_APP_PRIVATE_KEY="$(<"$SCRUFFY_GH_APP_PRIVATE_KEY_FILE")" \
SCRUFFY_GH_APP_ID="$SCRUFFY_GH_APP_ID" \
SCRUFFY_GH_APP_INSTALLATION_ID="$SCRUFFY_GH_APP_INSTALLATION_ID" \
npm --prefix "$REPO_ROOT" run app:doctor

if az acr repository show --subscription "$SUBSCRIPTION_ID" --name "$ACR_NAME" --image "scruffy:$GIT_SHA" >/dev/null 2>&1; then
  echo "Reusing immutable image $IMAGE"
else
  echo "Building immutable image $IMAGE in $ACR_NAME"
  az acr build \
    --subscription "$SUBSCRIPTION_ID" \
    --registry "$ACR_NAME" \
    --image "scruffy:$GIT_SHA" \
    "$REPO_ROOT"
fi

echo "Provisioning the private platform and managed identity"
write_parameters false
az deployment group create \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOYMENT_NAME" \
  --template-file "$TEMPLATE" \
  --parameters "@$PARAMETERS_FILE" \
  --query properties.provisioningState -o tsv

echo "Deploying the always-on Container App with pull-only identity $ACR_PULL_IDENTITY"
write_parameters true
az deployment group create \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOYMENT_NAME" \
  --template-file "$TEMPLATE" \
  --parameters "@$PARAMETERS_FILE" \
  --query properties.provisioningState -o tsv

HEALTH_URL="$(az deployment group show --subscription "$SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" --query properties.outputs.healthUrl.value -o tsv)"
WEBHOOK_URL="$(az deployment group show --subscription "$SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" --query properties.outputs.webhookUrl.value -o tsv)"

printf 'Waiting for %s\n' "$HEALTH_URL"
healthy=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 10 "$HEALTH_URL" | jq -e '.ok == true' >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 10
done
if [[ "$healthy" != true ]]; then
  echo "Scruffy did not become healthy; inspect logs with:" >&2
  echo "az containerapp logs show -g $RESOURCE_GROUP -n scruffy-shadow --follow" >&2
  exit 1
fi

cat <<EOF

Scruffy shadow is healthy.
Health:  $HEALTH_URL
Webhook: $WEBHOOK_URL
Image:   $IMAGE

Paste the Webhook URL into the GitHub App, select Active, and keep scruffy/poison non-required.
EOF
