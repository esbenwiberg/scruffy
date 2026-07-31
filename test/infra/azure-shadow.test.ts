import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bicep = readFileSync(new URL("../../infra/azure/main.bicep", import.meta.url), "utf8");
const deploy = readFileSync(
  new URL("../../scripts/deploy-azure-shadow.sh", import.meta.url),
  "utf8",
);

describe("Azure shadow real model configuration", () => {
  it("Azure shadow real model configuration", () => {
    expect(bicep).toContain("param modelBackend string");
    expect(bicep).toContain("name: 'SCRUFFY_MODEL_BACKEND'\n              value: modelBackend");
    expect(bicep).toContain("name: 'AZURE_FOUNDRY_BASE_URL'");
    expect(bicep).toContain("name: 'AZURE_FOUNDRY_DEPLOYMENT'");
    expect(bicep).toContain("name: 'AZURE_CLIENT_ID'");
    expect(bicep).toContain("name: 'SCRUFFY_RELEASE_TARGET_ENVIRONMENT'");
    expect(bicep).toContain("bba48692-92b0-4667-a9ad-c31c7b334ac2");
    expect(bicep).toContain("roleDefinitionId");
    expect(bicep).not.toContain("AZURE_FOUNDRY_API_KEY");
    expect(bicep).toContain("authority: 'shadow-only'");
    expect(bicep).toContain("minReplicas: 1");
    expect(bicep).toContain("maxReplicas: 1");

    expect(deploy).toContain('MODEL_BACKEND="${SCRUFFY_MODEL_BACKEND:-fake}"');
    expect(deploy).toContain("AZURE_FOUNDRY_RESOURCE and AZURE_FOUNDRY_DEPLOYMENT are required");
    expect(deploy).toContain("releaseOidcWorkflowRef");
    expect(deploy).not.toContain("AZURE_FOUNDRY_API_KEY");
  });
});
