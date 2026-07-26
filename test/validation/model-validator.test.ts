import { describe, expect, it } from "vitest";
import { ModelValidator } from "../../src/providers/validation/model-validator.js";
import { deterministicFinding } from "../../src/providers/analyzers/finding.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/providers/models/port.js";

const FINDING = deterministicFinding({
  ruleId: "SECRET.AWS_ACCESS_KEY",
  defectClass: "leaked-credential",
  subject: { repository: "acme/web", commitSha: "a".repeat(40) },
  path: "src/config.ts",
  line: 3,
  snippet: "AWS_KEY = 'AKIAIJKLMNOP12345678'",
  analyzerId: "secret-scan",
  analyzerVersion: "1.0.0",
  statement: "matches AWS access key id",
});

/** Stub model returning a fixed text, or throwing, so we can exercise every path. */
function stub(behavior: string | (() => never)): ModelProvider {
  return {
    id: "stub",
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      if (typeof behavior === "function") behavior();
      return { modelId: "stub", text: behavior as string };
    },
  };
}

describe("ModelValidator output tolerance", () => {
  it("finds the verdict when the prose before it contains a brace", async () => {
    const chatty = 'Looking at the {config} block first.\n{"verdict":"refuted","reason":"example key"}';
    expect(await new ModelValidator(stub(chatty)).validate(FINDING)).toBe("refuted");
  });

  it("falls inward when the verdict arrives wrapped in an envelope", async () => {
    // Outermost-first candidate order means the outer object is tried and fails
    // the schema, then the inner one matches.
    const enveloped = '{"result":{"verdict":"validated","reason":"live key"}}';
    expect(await new ModelValidator(stub(enveloped)).validate(FINDING)).toBe("validated");
  });

  it("still abstains when a brace-bearing reply holds no verdict at all", async () => {
    // Tolerance must not become credulity: no verdict means `failed`, never a
    // guessed one.
    expect(await new ModelValidator(stub('{"status":"ok"} and {"note":"none"}')).validate(FINDING)).toBe("failed");
  });

  it("does not accept a verdict outside the enum", async () => {
    expect(await new ModelValidator(stub('{"verdict":"probably_fine","reason":"x"}')).validate(FINDING)).toBe("failed");
  });
});

describe("ModelValidator", () => {
  it("maps a validated verdict through", async () => {
    const v = new ModelValidator(stub('{"verdict":"validated","reason":"real live key"}'));
    expect(await v.validate(FINDING)).toBe("validated");
  });

  it("maps a refuted verdict through", async () => {
    const v = new ModelValidator(stub('{"verdict":"refuted","reason":"documentation example key"}'));
    expect(await v.validate(FINDING)).toBe("refuted");
  });

  it("maps an indeterminate verdict through", async () => {
    const v = new ModelValidator(stub('{"verdict":"indeterminate","reason":"cannot tell without more context"}'));
    expect(await v.validate(FINDING)).toBe("indeterminate");
  });

  it("tolerates minor prose around the JSON object", async () => {
    const v = new ModelValidator(stub('Here is my verdict:\n{"verdict":"refuted","reason":"placeholder"}\nThanks.'));
    expect(await v.validate(FINDING)).toBe("refuted");
  });

  it("returns failed on unparseable output — never a fabricated validated", async () => {
    const v = new ModelValidator(stub("I think this is probably fine, no JSON here."));
    expect(await v.validate(FINDING)).toBe("failed");
  });

  it("returns failed when the verdict value is out of range", async () => {
    const v = new ModelValidator(stub('{"verdict":"looks_ok","reason":"x"}'));
    expect(await v.validate(FINDING)).toBe("failed");
  });

  it("returns failed when the provider throws — infra failure abstains", async () => {
    const v = new ModelValidator(
      stub(() => {
        throw new Error("network down");
      }),
    );
    expect(await v.validate(FINDING)).toBe("failed");
  });
});
