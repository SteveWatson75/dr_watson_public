import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE = "workspace";

export async function loadCeoContext(): Promise<string> {
  // The CEO pack is personal/local-only and intentionally not shipped in the repo.
  // Degrading gracefully keeps forks (and the CLI without a pack) working.
  try {
    return (await readFile(join("memory", "CEO_CONTEXT.md"), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function listProjects(): Promise<string[]> {
  const entries = await readdir(WORKSPACE, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function loadProjectContext(project: string): Promise<string> {
  const directory = join(WORKSPACE, project);
  const files = ["PROJECT.md", "decisions.md", "tasks.md"];
  const sections: string[] = [];

  for (const file of files) {
    try {
      const content = await readFile(join(directory, file), "utf8");
      sections.push(`## ${file}\n${content.trim()}`);
    } catch {
      // Project files are intentionally optional.
    }
  }

  if (!sections.length) {
    throw new Error(`No project context found for "${project}".`);
  }

  return sections.join("\n\n");
}
