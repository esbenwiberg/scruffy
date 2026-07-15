import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";

/**
 * Analyzer port. An analyzer inspects changed files and emits candidate findings
 * carrying full provenance and evidence. Analyzers do NOT decide — they produce
 * evidence the pure poison kernel later evaluates against policy.
 *
 * Findings are emitted with validation `pending`; a separate validation step
 * sets the terminal validation outcome. Language-specific and model-backed
 * analyzers implement this same port.
 */
export interface Analyzer {
  readonly id: string;
  analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]>;
}
