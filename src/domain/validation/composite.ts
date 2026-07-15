import type { Validator } from "./port.js";
import type { Finding, ValidationOutcome } from "../evidence/types.js";

/**
 * Routes a finding to the validator registered for its defect class. A finding
 * whose class has no validator returns `indeterminate` — an unknown class cannot
 * be affirmatively validated, so the gate abstains rather than blocking or
 * silently allowing it. This keeps "add an analyzer" from accidentally enabling
 * unvalidated blocks.
 */
export class CompositeValidator implements Validator {
  readonly id = "composite-validator";
  readonly #byClass: Map<string, Validator>;

  constructor(byClass: Record<string, Validator>) {
    this.#byClass = new Map(Object.entries(byClass));
  }

  async validate(finding: Finding): Promise<ValidationOutcome> {
    const validator = this.#byClass.get(finding.defectClass);
    if (!validator) return "indeterminate";
    return validator.validate(finding);
  }
}
