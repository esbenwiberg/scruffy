targetScope = 'resourceGroup'

@description('Azure region for the complete Scruffy shadow stack.')
param location string = resourceGroup().location

@description('Prefix used for resources whose names are local to the resource group.')
param namePrefix string = 'scruffy-shadow'

@description('Resource group containing the existing Azure Container Registry.')
param acrResourceGroupName string = 'ewi-sandboxes'

@description('Name of the existing Azure Container Registry.')
param acrName string = 'ewiautopodacr'

@description('Existing pull-only managed identity used by shared sandbox workloads.')
param acrPullIdentityName string = 'autopod-sandbox-acr-pull'

@description('Immutable image reference, normally ewiautopodacr.azurecr.io/scruffy:<git-sha>.')
param image string

@description('Deploy the Container App after its managed identity has AcrPull on the existing registry.')
param deployContainerApp bool = false

@description('Numeric GitHub App id.')
param githubAppId string

@description('Numeric GitHub App installation id.')
param githubInstallationId string

@secure()
@description('GitHub App PEM private key. It is persisted only as a Key Vault secret.')
param githubPrivateKey string

@secure()
@description('GitHub webhook HMAC secret. It must exactly match the value configured in GitHub.')
param webhookSecret string

@secure()
@minLength(16)
@description('PostgreSQL administrator password. Use URL-safe characters only.')
param postgresAdminPassword string

@description('PostgreSQL administrator login.')
param postgresAdminUser string = 'scruffyadmin'

@description('PostgreSQL major version.')
@allowed([
  '16'
  '17'
])
param postgresVersion string = '16'

@description('PostgreSQL compute SKU for the persistent shadow environment.')
param postgresSkuName string = 'Standard_B1ms'

@description('Hosted nightly cadence in milliseconds. Defaults to daily after the live test.')
param nightlyCadenceMs string = '86400000'

@description('How often the hosted process polls for nightly work.')
param nightlyTickMs string = '300000'

@allowed([
  'fake'
  'azure'
])
@description('Model backend. Azure requires an existing Foundry resource/deployment and managed-identity RBAC.')
param modelBackend string = 'fake'

@description('Existing Microsoft Foundry/Cognitive Services account name. Required when modelBackend=azure.')
param foundryResourceName string = ''

@description('Claude deployment name inside the Foundry resource. Required when modelBackend=azure.')
param foundryDeploymentName string = ''

@description('Fixed GitHub Actions OIDC audience accepted by the hosted release API.')
param releaseOidcAudience string = 'scruffy-release'

@description('Single allowlisted owner/repository for the initial hosted release protocol.')
param releaseOidcRepository string = ''

@description('Stable numeric GitHub repository id for the OIDC allowlist.')
param releaseOidcRepositoryId string = ''

@description('Allowlisted reusable job_workflow_ref, pinned to an immutable revision.')
param releaseOidcWorkflowRef string = ''

@description('Single service-allowlisted deployment target for the initial hosted release protocol.')
param releaseTargetEnvironment string = ''

@description('Protected GitHub Environment used for human exception approval.')
param releaseApprovalEnvironment string = ''

@description('Object id of the operator allowed to read deployment secrets from Key Vault.')
param operatorObjectId string

var compactToken = uniqueString(subscription().id, resourceGroup().id)
var containerAppName = namePrefix
var containerEnvironmentName = '${namePrefix}-env'
var identityName = '${namePrefix}-identity'
var logAnalyticsName = '${namePrefix}-logs'
var postgresName = take(toLower('${namePrefix}-${compactToken}-pg'), 63)
var keyVaultName = take(toLower(replace('${namePrefix}${compactToken}kv', '-', '')), 24)
var vnetName = '${namePrefix}-vnet'
var privateDnsZoneName = 'privatelink.postgres.database.azure.com'
var postgresDatabaseName = 'scruffy'
var postgresHost = '${postgresName}.postgres.database.azure.com'
var databaseUrl = 'postgresql://${postgresAdminUser}:${postgresAdminPassword}@${postgresHost}:5432/${postgresDatabaseName}?sslmode=verify-full'
var resourceTags = {
  application: 'scruffy'
  authority: 'shadow-only'
  deployment: 'scruffy-shadow'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
  scope: resourceGroup(acrResourceGroupName)
}

resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: acrPullIdentityName
  scope: resourceGroup(acrResourceGroupName)
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (modelBackend == 'azure') {
  name: foundryResourceName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: resourceTags
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: resourceTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'container-apps-environment'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.42.2.0/28'
          delegations: [
            {
              name: 'postgres-flexible-server'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  name: 'container-apps'
  parent: vnet
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  name: 'postgres'
  parent: vnet
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateDnsZoneName
  location: 'global'
  tags: resourceTags
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  name: '${vnetName}-link'
  parent: privateDnsZone
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  tags: resourceTags
  sku: {
    name: postgresSkuName
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    version: postgresVersion
    createMode: 'Create'
    availabilityZone: '1'
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: privateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
  }
  dependsOn: [
    privateDnsLink
  ]
}

resource scruffyDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  name: postgresDatabaseName
  parent: postgres
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: resourceTags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvironmentName
  location: location
  tags: resourceTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnet.id
      internal: false
    }
    zoneRedundant: false
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: resourceTags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: false
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
    accessPolicies: [
      {
        tenantId: tenant().tenantId
        objectId: identity.properties.principalId
        permissions: {
          secrets: [
            'get'
          ]
        }
      }
      {
        tenantId: tenant().tenantId
        objectId: operatorObjectId
        permissions: {
          secrets: [
            'get'
            'list'
            'set'
          ]
        }
      }
    ]
  }
}

resource foundryInferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (modelBackend == 'azure') {
  name: guid(foundry.id, identity.id, 'bba48692-92b0-4667-a9ad-c31c7b334ac2')
  scope: foundry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'bba48692-92b0-4667-a9ad-c31c7b334ac2'
    )
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'database-url'
  parent: keyVault
  properties: {
    value: databaseUrl
  }
}

resource githubPrivateKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'github-private-key'
  parent: keyVault
  properties: {
    value: githubPrivateKey
  }
}

resource webhookSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'webhook-secret'
  parent: keyVault
  properties: {
    value: webhookSecret
  }
}

resource postgresPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  name: 'postgres-admin-password'
  parent: keyVault
  properties: {
    value: postgresAdminPassword
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApp) {
  name: containerAppName
  location: location
  tags: resourceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
      '${acrPullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: acrPullIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: databaseUrlSecret.properties.secretUri
          identity: identity.id
        }
        {
          name: 'github-private-key'
          keyVaultUrl: githubPrivateKeySecret.properties.secretUri
          identity: identity.id
        }
        {
          name: 'webhook-secret'
          keyVaultUrl: webhookSecretResource.properties.secretUri
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'scruffy'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'SCRUFFY_WEBHOOK_SECRET'
              secretRef: 'webhook-secret'
            }
            {
              name: 'SCRUFFY_GH_APP_PRIVATE_KEY'
              secretRef: 'github-private-key'
            }
            {
              name: 'SCRUFFY_GH_APP_ID'
              value: githubAppId
            }
            {
              name: 'SCRUFFY_GH_APP_INSTALLATION_ID'
              value: githubInstallationId
            }
            {
              name: 'SCRUFFY_SCM_READER'
              value: 'github-app'
            }
            {
              name: 'SCRUFFY_SCM_WRITER'
              value: 'github-app'
            }
            {
              name: 'SCRUFFY_MODEL_BACKEND'
              value: modelBackend
            }
            {
              name: 'AZURE_FOUNDRY_BASE_URL'
              value: modelBackend == 'azure' ? 'https://${foundryResourceName}.services.ai.azure.com/anthropic' : ''
            }
            {
              name: 'AZURE_FOUNDRY_DEPLOYMENT'
              value: modelBackend == 'azure' ? foundryDeploymentName : ''
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identity.properties.clientId
            }
            {
              name: 'SCRUFFY_RELEASE_OIDC_AUDIENCE'
              value: releaseOidcAudience
            }
            {
              name: 'SCRUFFY_RELEASE_OIDC_REPOSITORY'
              value: releaseOidcRepository
            }
            {
              name: 'SCRUFFY_RELEASE_OIDC_REPOSITORY_ID'
              value: releaseOidcRepositoryId
            }
            {
              name: 'SCRUFFY_RELEASE_OIDC_WORKFLOW_REF'
              value: releaseOidcWorkflowRef
            }
            {
              name: 'SCRUFFY_RELEASE_TARGET_ENVIRONMENT'
              value: releaseTargetEnvironment
            }
            {
              name: 'SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT'
              value: releaseApprovalEnvironment
            }
            {
              name: 'SCRUFFY_NIGHTLY_CADENCE_MS'
              value: nightlyCadenceMs
            }
            {
              name: 'SCRUFFY_NIGHTLY_TICK_MS'
              value: nightlyTickMs
            }
            {
              name: 'SCRUFFY_NIGHTLY_OWNER'
              value: 'azure:scruffy-shadow'
            }
            {
              name: 'PORT'
              value: '8080'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    scruffyDatabase
  ]
}

output containerAppName string = containerAppName
output containerAppFqdn string = deployContainerApp ? containerApp!.properties.configuration.ingress.fqdn : ''
output healthUrl string = deployContainerApp
  ? 'https://${containerApp!.properties.configuration.ingress.fqdn}/healthz'
  : ''
output webhookUrl string = deployContainerApp
  ? 'https://${containerApp!.properties.configuration.ingress.fqdn}/webhook'
  : ''
output keyVaultName string = keyVault.name
output postgresServerName string = postgres.name
output imageReference string = image
output managedIdentityId string = identity.id
output managedIdentityPrincipalId string = identity.properties.principalId
output acrId string = acr.id
output acrPullIdentityId string = acrPullIdentity.id
