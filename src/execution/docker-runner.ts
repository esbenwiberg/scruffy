import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import {
  DEFAULT_LIMITS,
  JOB_ID_PATTERN,
  type HostileRunner,
  type RunnerJob,
  type RunnerLimits,
  type RunnerResult,
} from "./hostile-runner.js";

/**
 * Docker-backed hostile runner — the LOCAL SPIKE for ADR-0003 validation #5.
 *
 * Every negative capability the ADR lists maps to an explicit engine flag:
 *
 *   fresh disposable environment      --rm, unique container name, per-job
 *                                     temp input dir, tmpfs scratch
 *   no credentials                    no env passed in, image carries none;
 *                                     host env NEVER crosses (docker run only
 *                                     forwards what -e/--env-file name — we
 *                                     name nothing)
 *   no cloud metadata / internal svc  --network none (default-deny; there is
 *                                     no allowlist path in the spike at all)
 *   no other job's filesystem         input dir is per-job and read-only;
 *                                     scratch is a per-container tmpfs that
 *                                     dies with the container
 *   read-only input, bounded scratch  -v <job>:/job:ro, --read-only rootfs,
 *                                     --tmpfs /scratch:rw,size=<n>m
 *   non-root, no capabilities         --user 65534:65534, --cap-drop ALL,
 *                                     --security-opt no-new-privileges
 *   resource quotas                   --memory, --cpus, --pids-limit
 *   wall-clock timeout                deadline -> docker kill -> environment
 *                                     destroyed
 *   bounded hostile output            per-stream byte caps with truncation
 *                                     flags; output is never parsed as trusted
 *
 * HONESTY BOUNDARY (the ADR's own warning): a container is not automatically a
 * sufficient hostile-code boundary. This spike PROVES the negative capabilities
 * hold under this engine's default seccomp/namespace hardening on a dev
 * machine (test/execution/docker-runner.test.ts runs hostile jobs and asserts
 * they fail to escape). Selecting the production isolation technology
 * (gVisor / microVM / managed sandbox) from the deployment threat model is the
 * remaining, deliberately separate half of validation #5.
 */

const DEFAULT_IMAGE = "busybox:1.36";

export interface DockerRunnerOptions {
  /** Sandbox image. Pinned by the operator; jobs cannot choose it. */
  image?: string;
  /** Docker binary, injectable for tests. */
  dockerBin?: string;
}

export class DockerRunner implements HostileRunner {
  readonly #image: string;
  readonly #docker: string;

  constructor(options: DockerRunnerOptions = {}) {
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.#docker = options.dockerBin ?? "docker";
  }

  async run(job: RunnerJob): Promise<RunnerResult> {
    if (!JOB_ID_PATTERN.test(job.id)) {
      // The id names the container; anything outside the strict charset could
      // smuggle flags or collide names. Reject, don't sanitize.
      throw new Error(`invalid job id '${job.id}' (expected ${JOB_ID_PATTERN})`);
    }
    if (job.command.length === 0) throw new Error("job command must not be empty");
    const limits: RunnerLimits = { ...DEFAULT_LIMITS, ...job.limits };
    const container = `scruffy-hostile-${job.id}`;

    // Per-job input workspace, mounted read-only. /tmp specifically: on macOS
    // Docker Desktop shares /private/tmp by default; os.tmpdir() may not be in
    // the sharing list.
    const inputDir = await mkdtemp(join(tmpdir().startsWith("/var/") ? "/tmp" : tmpdir(), "scruffy-hostile-"));
    try {
      for (const [rel, content] of Object.entries(job.files ?? {})) {
        const target = normalize(join(inputDir, rel));
        if (!target.startsWith(inputDir + sep)) {
          // A hostile file name must not climb out of the job workspace.
          throw new Error(`job file path escapes the workspace: ${rel}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }

      const args = [
        "run",
        "--rm",
        "--name",
        container,
        "--network",
        "none",
        "--user",
        "65534:65534",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        // mode=1777 (sticky, /tmp semantics): the engine mounts tmpfs root-owned
        // by default, which would leave the non-root job with NO writable path
        // and make "nothing is writable" pass for the wrong reason.
        `/scratch:rw,size=${limits.scratchMb}m,mode=1777`,
        "--memory",
        `${limits.memoryMb}m`,
        "--cpus",
        String(limits.cpus),
        "--pids-limit",
        String(limits.pids),
        "--workdir",
        "/scratch",
        "-v",
        `${inputDir}:/job:ro`,
        "--init",
        this.#image,
        ...job.command,
      ];

      return await this.#execute(container, args, limits);
    } finally {
      await rm(inputDir, { recursive: true, force: true });
    }
  }

  #execute(container: string, args: string[], limits: RunnerLimits): Promise<RunnerResult> {
    return new Promise((resolve) => {
      const started = performance.now();
      const child = spawn(this.#docker, args, { stdio: ["ignore", "pipe", "pipe"] });

      let timedOut = false;
      const out = boundedCollector(limits.outputBytes);
      const err = boundedCollector(limits.outputBytes);
      child.stdout.on("data", out.push);
      child.stderr.on("data", err.push);

      const timer = setTimeout(() => {
        timedOut = true;
        // Destroy the environment; --rm removes it once killed. The docker CLI
        // child then exits and the close handler below settles the result.
        spawn(this.#docker, ["kill", container], { stdio: "ignore" }).on("error", () => {});
      }, limits.timeoutMs);

      child.on("error", () => {
        // The docker binary itself could not run — an infrastructure fault.
        clearTimeout(timer);
        resolve({
          outcome: "infra_failure",
          exitCode: null,
          stdout: out.text(),
          stderr: err.text(),
          stdoutTruncated: out.truncated(),
          stderrTruncated: err.truncated(),
          durationMs: performance.now() - started,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // 125 is the docker CLI's own failure (bad flag, daemon down, missing
        // image) — the job never ran, so that is infra, not a job verdict.
        const outcome: RunnerResult["outcome"] = timedOut ? "timeout" : code === 125 ? "infra_failure" : "completed";
        resolve({
          outcome,
          exitCode: timedOut ? null : code,
          stdout: out.text(),
          stderr: err.text(),
          stdoutTruncated: out.truncated(),
          stderrTruncated: err.truncated(),
          durationMs: performance.now() - started,
        });
      });
    });
  }
}

/** Collects at most `cap` bytes; keeps counting so truncation is reportable. */
function boundedCollector(cap: number): { push: (c: Buffer) => void; text: () => string; truncated: () => boolean } {
  const chunks: Buffer[] = [];
  let kept = 0;
  let seen = 0;
  return {
    push: (chunk: Buffer) => {
      seen += chunk.length;
      if (kept >= cap) return;
      const take = chunk.subarray(0, cap - kept);
      chunks.push(take);
      kept += take.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => seen > kept,
  };
}
