/**
 * Tests for ZCode agent support: MCP registration, hooks, and skill install.
 *
 * ZCode differs from the other supported agents:
 * - Config lives at ~/.zcode/cli/config.json
 * - MCP servers are nested under "mcp.servers" (not a top-level "mcpServers")
 * - Hooks are nested under "hooks.events" and require hooks.enabled = true
 * - ZCode has no PostCompaction/SessionEnd events; session-end maps to Stop
 * - Server schema is strict: an unknown key silently drops the server
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks, uninstallHooks } from "../../src/hooks.js";
import { installMcpServer } from "../../src/install-mcp.js";
import { installSkill } from "../../src/install-skill.js";

const ORIG_HOME = process.env.HOME;

function withTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "remem-zcode-"));
  process.env.HOME = dir;
  return dir;
}

function restoreHome(): void {
  if (ORIG_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIG_HOME;
  }
}

/** Create ~/.zcode/cli with an (optional) initial config.json. */
function makeZcodeCli(home: string, config: unknown = {}): string {
  const cliDir = join(home, ".zcode", "cli");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  return cliDir;
}

function readConfig(dir: string): Record<string, unknown> {
  const path = join(dir, ".zcode", "cli", "config.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("ZCode agent support", () => {
  let home: string;

  beforeEach(() => {
    home = withTempHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreHome();
  });

  // ─── MCP server registration ───────────────────────────────────────

  describe("installMcpServer", () => {
    it("registers under mcp.servers when the ~/.zcode/cli directory exists", async () => {
      // Simulate an installed ZCode: the CLI directory must be present.
      makeZcodeCli(home);

      await installMcpServer();

      const config = readConfig(home);
      const servers = (config.mcp as { servers: Record<string, unknown> }).servers;
      expect(servers).toBeDefined();
      expect(servers["remem-mcp"]).toEqual({
        command: "npx",
        args: ["-y", "remem-mcp"],
      });
    });

    it("writes only canonical stdio fields (strict schema: unknown keys drop the server)", async () => {
      makeZcodeCli(home);

      await installMcpServer();

      const servers = (readConfig(home).mcp as { servers: Record<string, unknown> }).servers;
      const entry = servers["remem-mcp"] as Record<string, unknown>;
      // type/command/args/env/cwd/enabled/timeoutMs are the only allowed keys.
      expect(Object.keys(entry).sort()).toEqual(["args", "command"]);
    });

    it("nests correctly under an existing config with other servers and keys", async () => {
      makeZcodeCli(home, {
        mcp: { servers: { "chrome-devtools": { type: "stdio", command: "npx", args: [] } } },
        plugins: { enabledPlugins: { "github@zcode-plugins-official": true } },
      });

      await installMcpServer();

      const config = readConfig(home);
      // Unrelated keys must survive.
      expect(config.plugins).toEqual({ enabledPlugins: { "github@zcode-plugins-official": true } });
      const servers = (config.mcp as { servers: Record<string, unknown> }).servers;
      expect(Object.keys(servers).sort()).toEqual(["chrome-devtools", "remem-mcp"]);
    });

    it("is idempotent — re-running does not duplicate or overwrite the entry", async () => {
      makeZcodeCli(home);

      await installMcpServer();
      await installMcpServer();

      const servers = (readConfig(home).mcp as { servers: Record<string, unknown> }).servers;
      expect(Object.keys(servers)).toEqual(["remem-mcp"]);
    });

    it("preserves a pre-existing mcp.servers entry shape", async () => {
      makeZcodeCli(home);

      await installMcpServer();
      // Simulate a user editing the entry (e.g. adding env).
      const config = readConfig(home);
      const servers = (config.mcp as { servers: Record<string, unknown> }).servers;
      servers["remem-mcp"] = { type: "stdio", command: "npx", args: ["-y", "remem-mcp"], env: {} };
      writeFileSync(
        join(home, ".zcode", "cli", "config.json"),
        JSON.stringify(config, null, 2),
        "utf-8",
      );

      await installMcpServer();

      const after = (readConfig(home).mcp as { servers: Record<string, unknown> }).servers;
      expect(after["remem-mcp"]).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "remem-mcp"],
        env: {},
      });
    });

    it("skips ZCode when ~/.zcode is absent", async () => {
      await installMcpServer();

      // No config file created, no crash.
      expect(existsSync(join(home, ".zcode", "cli", "config.json"))).toBe(false);
    });

    it("creates cli/config.json when only ~/.zcode exists", async () => {
      mkdirSync(join(home, ".zcode"), { recursive: true });

      await installMcpServer();

      const servers = (readConfig(home).mcp as { servers: Record<string, unknown> }).servers;
      expect(servers["remem-mcp"]).toBeDefined();
    });
  });

  // ─── Hooks ──────────────────────────────────────────────────────────

  describe("installHooks", () => {
    it("writes hooks under hooks.events and enables the runner", async () => {
      makeZcodeCli(home);

      await installHooks();

      const hooks = readConfig(home).hooks as {
        enabled: boolean;
        events: Record<string, unknown[]>;
      };
      expect(hooks.enabled).toBe(true);
      expect(Object.keys(hooks.events).sort()).toEqual([
        "PostToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ]);
    });

    it("creates cli/config.json when only ~/.zcode exists", async () => {
      mkdirSync(join(home, ".zcode"), { recursive: true });

      await installHooks();

      const hooks = readConfig(home).hooks as { enabled: boolean };
      expect(hooks.enabled).toBe(true);
    });

    it("does not install PostCompaction (unsupported by ZCode)", async () => {
      makeZcodeCli(home);

      await installHooks();

      const hooks = readConfig(home).hooks as { events: Record<string, unknown[]> };
      expect(hooks.events.PostCompaction).toBeUndefined();
      expect(hooks.events.PostCompact).toBeUndefined();
      expect(hooks.events.SessionEnd).toBeUndefined();
    });

    it("routes session-end capture to the Stop event", async () => {
      makeZcodeCli(home);

      await installHooks();

      const events = (readConfig(home).hooks as { events: Record<string, unknown[]> }).events;
      const stopHooks = events.Stop[0] as { hooks: { command: string }[] };
      expect(stopHooks.hooks[0].command).toContain("hook-stop");
    });

    it("installs the recall hook on SessionStart", async () => {
      makeZcodeCli(home);

      await installHooks();

      const events = (readConfig(home).hooks as { events: Record<string, unknown[]> }).events;
      const startHooks = events.SessionStart[0] as { hooks: { command: string }[] };
      expect(startHooks.hooks[0].command).toContain("hook-recall");
    });

    it("is idempotent across reinstalls", async () => {
      makeZcodeCli(home);

      await installHooks();
      await installHooks();

      const events = (readConfig(home).hooks as { events: Record<string, unknown[]> }).events;
      // Each event still has exactly one remem-mcp entry.
      for (const ev of Object.keys(events)) {
        expect(events[ev]).toHaveLength(1);
      }
    });

    it("preserves unrelated config keys and user hooks", async () => {
      const cliDir = makeZcodeCli(home);
      writeFileSync(
        join(cliDir, "config.json"),
        JSON.stringify({
          mcp: { servers: {} },
          hooks: {
            enabled: false,
            events: {
              SessionStart: [
                {
                  matcher: "startup",
                  hooks: [{ type: "command", command: "echo user-hook" }],
                },
              ],
            },
          },
        }),
        "utf-8",
      );

      await installHooks();

      const config = readConfig(home);
      expect(config.mcp).toEqual({ servers: {} });
      const events = (config.hooks as { events: Record<string, unknown[]> }).events;
      // User hook preserved alongside ours.
      expect(events.SessionStart).toHaveLength(2);
      expect(
        (events.SessionStart[0] as { hooks: { command: string }[] }).hooks[0].command,
      ).toContain("echo user-hook");
    });

    it("uninstall removes remem-mcp hooks but keeps user hooks", async () => {
      const configPath = join(makeZcodeCli(home), "config.json");

      await installHooks();
      // Add a user hook to a different event.
      const config = readConfig(home);
      (config.hooks as { events: Record<string, unknown[]> }).events.PreToolUse = [
        { hooks: [{ type: "command", command: "echo user-hook" }] },
      ];
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      await uninstallHooks();

      const after = readConfig(home).hooks as { events: Record<string, unknown[]> };
      expect(after.events.SessionStart).toBeUndefined();
      expect(after.events.UserPromptSubmit).toBeUndefined();
      expect(after.events.Stop).toBeUndefined();
      expect(after.events.PreToolUse).toHaveLength(1);
    });

    it("uninstall leaves no empty hooks object behind", async () => {
      const configPath = join(makeZcodeCli(home, { mcp: { servers: {} } }), "config.json");

      await installHooks();
      await uninstallHooks();

      const after = readConfig(home);
      expect(after.hooks).toBeUndefined();
      // Unrelated key survives.
      expect(after.mcp).toEqual({ servers: {} });
    });
  });

  // ─── Skill ──────────────────────────────────────────────────────────

  describe("installSkill", () => {
    it("installs the skill to ~/.zcode/skills", async () => {
      await installSkill();

      const skillPath = join(home, ".zcode", "skills", "remem-mcp", "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      const content = readFileSync(skillPath, "utf-8");
      expect(content).toContain("name: remem-mcp");
      // ZCode drops a skill whose description exceeds 1024 characters.
      const desc = content.match(/^description: (.+)$/m)?.[1] ?? "";
      expect(desc.length).toBeLessThan(1024);
    });
  });
});
