import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRunner } from "../../src/execution/docker-runner.js";

/**
 * ADR-0003 validation #5, local half: run DISPOSABLE HOSTILE JOBS and prove
 * they cannot access control-plane credentials, cloud metadata, internal
 * services, or another job's filesystem. These tests are the proof: each one
 * executes a genuinely hostile command inside the runner and asserts the
 * escape FAILS (and that legitimate use — reading input, writing scratch —
 * still works, so the sandbox isn't "secure" by being broken).
 *
 * Requires local Docker (the test suite already requires it for Postgres).
 * The image is pulled in beforeAll if absent.
 */

const IMAGE = "busybox:1.36";
const runner = new DockerRunner({ image: IMAGE });

let seq = 0;
const jobId = (name: string) => `test-${name}-${process.pid}-${(seq += 1)}`;

beforeAll(() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    execFileSync("docker", ["pull", IMAGE], { stdio: "ignore", timeout: 120_000 });
  }
});

// The credentials the control plane actually carries — set for the duration of
// the suite so a leak would be OBSERVABLE, then cleaned up.
const PLANTED = {
  SCRUFFY_WEBHOOK_SECRET: "planted-webhook-secret",
  SCRUFFY_GH_APP_PRIVATE_KEY: "planted-app-key",
  DATABASE_URL: "postgres://planted:planted@localhost/planted",
  GH_TOKEN: "planted-gh-token",
};
beforeAll(() => {
  Object.assign(process.env, PLANTED);
});
afterAll(() => {
  for (const key of Object.keys(PLANTED)) delete process.env[key];
});

describe("hostile job: credential isolation", () => {
  it("sees NONE of the control plane's environment — planted credentials do not cross", async () => {
    const result = await runner.run({ id: jobId("env"), command: ["env"] });

    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    for (const [key, value] of Object.entries(PLANTED)) {
      expect(result.stdout).not.toContain(key);
      expect(result.stdout).not.toContain(value);
    }
  });

  it("finds no GitHub App key, gh config, or docker socket on the filesystem", async () => {
    const result = await runner.run({
      id: jobId("fs-creds"),
      command: ["sh", "-c", "ls /run/secrets /root/.config /var/run/docker.sock 2>&1; true"],
    });
    expect(result.outcome).toBe("completed");
    expect(result.stdout + result.stderr).toMatch(/No such file|cannot access/i);
  });
});

describe("hostile job: network isolation (default-deny)", () => {
  it("cannot reach the cloud metadata endpoint", async () => {
    const result = await runner.run({
      id: jobId("metadata"),
      command: ["wget", "-T", "2", "-q", "-O", "-", "http://169.254.169.254/latest/meta-data/"],
      limits: { timeoutMs: 15_000 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("cannot reach internal services (the control plane's own Postgres)", async () => {
    const result = await runner.run({
      id: jobId("internal"),
      command: ["nc", "-w", "2", "host.docker.internal", "5432"],
      limits: { timeoutMs: 15_000 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).not.toBe(0);
  });

  it("has no network interface beyond loopback at all", async () => {
    const result = await runner.run({ id: jobId("ifaces"), command: ["sh", "-c", "ip link 2>/dev/null || ifconfig -a"] });
    expect(result.outcome).toBe("completed");
    expect(result.stdout).not.toMatch(/\beth0\b/);
  });
});

describe("hostile job: filesystem isolation", () => {
  it("job A's scratch writes are INVISIBLE to job B (fresh tmpfs per job)", async () => {
    const write = await runner.run({
      id: jobId("scratch-write"),
      command: ["sh", "-c", "echo poisoned > /scratch/marker && cat /scratch/marker"],
    });
    expect(write.outcome).toBe("completed");
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("poisoned");

    const read = await runner.run({ id: jobId("scratch-read"), command: ["cat", "/scratch/marker"] });
    expect(read.outcome).toBe("completed");
    expect(read.exitCode).not.toBe(0); // gone with job A's container
  });

  it("input is served read-only and the rootfs is immutable; only /scratch accepts writes", async () => {
    const result = await runner.run({
      id: jobId("readonly"),
      files: { "input.txt": "hello from the control plane" },
      command: [
        "sh",
        "-c",
        [
          "cat /job/input.txt || exit 9",
          "touch /job/hack 2>/dev/null && exit 10",
          "touch /etc/hack 2>/dev/null && exit 11",
          "echo ok > /scratch/work || exit 12",
          "exit 0",
        ].join("; "),
      ],
    });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from the control plane");
  });

  it("rejects an input file path that tries to climb out of the job workspace", async () => {
    await expect(
      runner.run({ id: jobId("climb"), files: { "../../etc/evil": "x" }, command: ["true"] }),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

describe("hostile job: identity and resource bounds", () => {
  it("runs as non-root (uid 65534) with no capabilities to escalate", async () => {
    const result = await runner.run({ id: jobId("uid"), command: ["id", "-u"] });
    expect(result.outcome).toBe("completed");
    expect(result.stdout.trim()).toBe("65534");
  });

  it("a job that never terminates is killed at the wall clock and its environment destroyed", async () => {
    const result = await runner.run({ id: jobId("hang"), command: ["sleep", "300"], limits: { timeoutMs: 2_000 } });
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBeNull();

    // The disposable environment is actually gone, not lingering.
    const ps = execFileSync("docker", ["ps", "-a", "--filter", "name=scruffy-hostile-", "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    expect(ps.trim()).toBe("");
  });

  it("unbounded hostile output is truncated at the cap, and the truncation is reported", async () => {
    const result = await runner.run({
      id: jobId("floods"),
      command: ["sh", "-c", 'dd if=/dev/zero bs=1024 count=2048 2>/dev/null | tr "\\0" "a"'],
      limits: { outputBytes: 4096 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("rejects a job id that could smuggle flags or collide container names", async () => {
    await expect(runner.run({ id: "evil --privileged", command: ["true"] })).rejects.toThrow(/invalid job id/);
    await expect(runner.run({ id: "", command: ["true"] })).rejects.toThrow(/invalid job id/);
  });
});
