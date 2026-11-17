import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("review policy workflow", () => {
  it("fails closed for skipped, cancelled, failed, missing or unapproved execution", async () => {
    const workflow = await readFile(".github/workflows/agent-review.yml", "utf8");
    const policy = workflow.split("  review-policy:\n")[1]!;
    expect(policy).toContain("if: always()");
    expect(policy).toContain("permissions: {}");
    expect(policy).not.toContain("uses:");
    expect(workflow).not.toContain("checks: write");
    expect(workflow).not.toContain("statuses: write");
    expect(workflow).toContain("name: review-execution");
    expect(workflow).toContain("approved: ${{ steps.verdict.outputs.approved }}");
    const script = policy
      .split("        run: |\n")[1]!
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
    for (const analysis of ["success", "failure", "skipped", "cancelled", ""]) {
      for (const publication of ["success", "failure", "skipped", "cancelled", ""]) {
        for (const approved of ["true", "false", ""]) {
          const result = spawnSync("bash", ["-e", "-c", script], {
            env: { ANALYSIS: analysis, PUBLICATION: publication, APPROVED: approved },
            encoding: "utf8",
          });
          const allowed =
            analysis === "success" && publication === "success" && approved === "true";
          expect(result.status).toBe(allowed ? 0 : 1);
          if (!allowed) expect(result.stdout).toContain("Review policy not satisfied");
        }
      }
    }
  });
});

describe("standard CI formatting gate", () => {
  it("runs existing read-only formatting validation after install, only in standard CI", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("permissions:\n  contents: read");
    expect(ci).toContain("- run: npm ci\n      - run: npm run format:check");
    expect(ci).toContain("- run: npm run typecheck");
    expect(ci).toContain("- run: npm run test");
    expect(ci).not.toContain("--write");
    const review = await readFile(".github/workflows/agent-review.yml", "utf8");
    expect(review).not.toContain("format:check");
    expect(review).not.toContain("prettier");
  });
  it("passes formatted code and rejects misformatted code without modifying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-format-check-"));
    try {
      for (const name of ["package.json", "tsconfig.json", ".prettierrc.json"])
        await writeFile(join(directory, name), await readFile(name));
      await mkdir(join(directory, "src"));
      const source = join(directory, "src/example.ts");
      const check = () =>
        spawnSync("npm", ["run", "format:check"], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH}`,
          },
          encoding: "utf8",
        });
      await writeFile(source, "export const example = 1;\n");
      expect(check().status).toBe(0);
      const misformatted = "export   const example=1\n";
      await writeFile(source, misformatted);
      const failed = check();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("src/example.ts");
      expect(await readFile(source, "utf8")).toBe(misformatted);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
