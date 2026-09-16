import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the directory containing this module (ESM-safe; __dirname is undefined in ESM). */
function moduleDir(): string {
  return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
}

/** Skill file content. Loaded from the bundled skills/ directory. */
function loadSkillContent(): string {
  const here = moduleDir();
  // Try multiple locations: cwd, package root, dist
  const candidates = [
    join(process.cwd(), "skills", "remem-mcp", "SKILL.md"),
    join(here, "..", "skills", "remem-mcp", "SKILL.md"),
    join(here, "skills", "remem-mcp", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // Try the next candidate
    }
  }

  throw new Error(
    "Could not find skills/remem-mcp/SKILL.md. Make sure the package includes the skills directory.",
  );
}

/** Supported agent skill directories.
 *
 * Resolved lazily (not at module load) so that a HOME override applied after
 * import — as done by tests — is honored.
 */
function skillTargets(): { name: string; path: string }[] {
  return [
    {
      name: "Devin CLI",
      path: join(homedir(), ".config", "devin", "skills", "remem-mcp", "SKILL.md"),
    },
    {
      name: "Claude Code",
      path: join(homedir(), ".claude", "skills", "remem-mcp", "SKILL.md"),
    },
    {
      name: "Codex CLI",
      path: join(homedir(), ".codex", "skills", "remem-mcp", "SKILL.md"),
    },
    {
      name: "ZCode",
      path: join(homedir(), ".zcode", "skills", "remem-mcp", "SKILL.md"),
    },
    {
      name: "Generic (.agents)",
      path: join(homedir(), ".agents", "skills", "remem-mcp", "SKILL.md"),
    },
  ];
}

/** Install the skill file to all supported agent directories. */
export async function installSkill(): Promise<void> {
  const skillContent = loadSkillContent();
  const names: string[] = [];

  for (const target of skillTargets()) {
    const dir = dirname(target.path);

    // Create the directory if it does not exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(target.path, skillContent, "utf-8");
    names.push(target.name);
  }

  console.log(`Skill: ${names.join(", ")}`);
}
