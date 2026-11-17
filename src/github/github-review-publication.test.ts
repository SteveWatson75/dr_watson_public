import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish } from "./github-review-cli.js";
import { prepareReview, type ReviewResult } from "./github-review.js";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const repo = "SteveWatson75/dr_watson_public";
const directories: string[] = [];
const previousExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function artifact() {
  const { manifest } = prepareReview({
    pr: 20,
    sha,
    base,
    title: "Small change",
    description: "",
    files: [
      {
        filename: "src/example.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+example();",
      },
    ],
  });
  const result: ReviewResult = {
    sha,
    outcome: "Approved",
    findings: [],
    manualQA: ["Check behavior manually."],
    reason: "No blocking defects in the supplied diff.",
  };
  return {
    manifest,
    result,
    diagnostics: {
      modelSuccess: true,
      cliSuccess: true,
      verdictValid: true,
      requestCount: 1,
      fallbackAttempts: 0,
      attempts: [
        {
          provider: "opencode",
          model: "mimo-v2.6-pro",
          durationMs: 1,
          category: "success",
        },
      ],
    },
  };
}
const finding: ReviewResult["findings"][number] = {
  path: "src/example.ts",
  side: "new",
  line: 1,
  defect: "Untrusted input reaches a shell command.",
  blockingReason: "Remote input can execute arbitrary commands.",
};

async function publication(
  value: unknown,
  options: { head?: string; base?: string; status?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "review-publication-"));
  directories.push(directory);
  if (value !== undefined) await writeFile(join(directory, "result.json"), JSON.stringify(value));
  vi.stubEnv("GITHUB_OUTPUT", join(directory, "output"));
  vi.stubEnv("GITHUB_STEP_SUMMARY", join(directory, "summary"));
  const calls = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          number: 20,
          title: "Small change",
          body: "",
          changed_files: 1,
          user: { login: "SteveWatson75" },
          head: { sha: options.head ?? sha, repo: { full_name: repo } },
          base: { ref: "main", sha: options.base ?? base, repo: { full_name: repo } },
        }),
      ),
    )
    .mockResolvedValueOnce(new Response("{}", { status: options.status ?? 200 }));
  vi.stubGlobal("fetch", calls);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
  await publish(20, sha, directory);
  return {
    exitCode: process.exitCode,
    output: await readFile(join(directory, "output"), "utf8"),
    summary: await readFile(join(directory, "summary"), "utf8"),
    posted: JSON.parse(calls.mock.calls[1]![1].body),
    diagnostics: JSON.parse(log.mock.calls[0]![0]),
    calls,
  };
}

describe("execution health is independent of review policy", () => {
  it.each(["pr", "sha"] as const)(
    "rejects artifact %s identity mismatch before any API write",
    async (field) => {
      const directory = await mkdtemp(join(tmpdir(), "review-artifact-identity-"));
      directories.push(directory);
      const value = artifact();
      if (field === "pr") value.manifest.pr = 21;
      else value.manifest.sha = base;
      await writeFile(join(directory, "result.json"), JSON.stringify(value));
      const calls = vi.fn();
      vi.stubGlobal("fetch", calls);
      await expect(publish(20, sha, directory)).rejects.toThrow("Artifact identity mismatch");
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it("allows only complete, current, successfully published approval through the policy output", async () => {
    const actual = await publication(artifact());
    expect(actual.exitCode).toBe(0);
    expect(actual.output).toBe("approved=true\n");
    expect(actual.diagnostics).toMatchObject({ executionSuccess: true, reviewApproved: true });
    expect(actual.posted).toMatchObject({ commit_id: sha, event: "COMMENT" });
    expect(actual.calls).toHaveBeenCalledTimes(2);
  });
  it.each(["coverage", "human", "model-incomplete", "blocking", "partial-blocking"] as const)(
    "publishes %s successfully without satisfying review policy",
    async (scenario) => {
      const value = artifact();
      if (scenario === "coverage" || scenario === "partial-blocking")
        value.manifest.fullScope = false;
      if (scenario === "human") value.manifest.humanRequired = true;
      if (scenario === "model-incomplete") value.result.outcome = "Incomplete";
      if (scenario === "blocking" || scenario === "partial-blocking") {
        // Concrete findings survive even if the model labels its broader review Incomplete.
        value.result.outcome = "Incomplete";
        value.result.findings = [finding];
      }
      const actual = await publication(value);
      expect(actual.exitCode).toBe(0);
      expect(actual.output).toBe("approved=false\n");
      expect(actual.diagnostics.executionSuccess).toBe(true);
      expect(actual.posted.body).not.toContain("**Approved**");
      if (scenario.includes("blocking")) {
        expect(actual.posted.body).toContain("**Has blocking changes needed**");
        expect(actual.posted.body).toContain(finding.defect);
      } else expect(actual.posted.body).toContain("**Incomplete**");
      if (scenario === "human")
        expect(actual.summary).toContain("required; automated approval prohibited");
    },
  );
  it.each([
    "missing",
    "schema",
    "line",
    "sha",
    "diagnostics",
    "client",
    "provider",
    "verdict",
  ] as const)("fails execution and policy for %s failure", async (scenario) => {
    const value = artifact();
    if (scenario === "line") {
      value.result.outcome = "Has blocking changes needed";
      value.result.findings = [{ ...finding, line: 999 }];
    }
    if (scenario === "sha") value.result.sha = base;
    if (scenario === "diagnostics") value.diagnostics.requestCount = 2;
    if (scenario === "client") value.diagnostics.cliSuccess = false;
    if (scenario === "provider") value.diagnostics.modelSuccess = false;
    if (scenario === "verdict") value.diagnostics.verdictValid = false;
    const actual = await publication(
      scenario === "missing"
        ? undefined
        : scenario === "schema"
          ? { ...value, extra: true }
          : value,
    );
    expect(actual.exitCode).toBe(1);
    expect(actual.output).toBe("approved=false\n");
    expect(actual.diagnostics.executionSuccess).toBe(false);
    expect(actual.diagnostics.executionError).toBeDefined();
    expect(actual.posted.body).toContain("**Incomplete**");
  });
  it.each([{ head: base }, { base: sha }])("fails for stale snapshot %j", async (options) => {
    const actual = await publication(artifact(), options);
    expect(actual.exitCode).toBe(1);
    expect(actual.output).toBe("approved=false\n");
    expect(actual.diagnostics.executionError).toBe("stale_snapshot");
    expect(actual.posted.commit_id).toBe(sha);
    expect(actual.posted.body).toContain("stale review, rerun required");
  });
  it("fails publication without retrying writes or broadening credentials", async () => {
    const actual = await publication(artifact(), { status: 503 });
    expect(actual.exitCode).toBe(1);
    expect(actual.output).toBe("approved=false\n");
    expect(actual.diagnostics).toMatchObject({
      executionError: "publication_failed",
      publicationSuccess: false,
      publicationStatus: 503,
    });
    expect(actual.calls).toHaveBeenCalledTimes(2);
  });
  it("abbreviates huge inventories without losing findings, exclusions or the blocking verdict", async () => {
    const value = artifact();
    value.manifest.fullScope = false;
    value.manifest.excluded = Array.from({ length: 900 }, (_, n) => ({
      path: `src/omitted-${n}.ts`,
      reason: "context budget: remaining hunks omitted (production implementation)",
    }));
    value.result.outcome = "Has blocking changes needed";
    value.result.findings = [finding];
    const actual = await publication(value);
    expect(actual.exitCode).toBe(0);
    expect(actual.output).toBe("approved=false\n");
    expect(Buffer.byteLength(actual.posted.body)).toBeLessThan(60_000);
    expect(actual.posted.body).toContain(finding.defect);
    expect(actual.posted.body).toContain("**Has blocking changes needed**");
    expect(actual.posted.body).toContain("inventory abbreviated");
    expect(actual.summary).toContain("src/omitted-899.ts");
  });
});
