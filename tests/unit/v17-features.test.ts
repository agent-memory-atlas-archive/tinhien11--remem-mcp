/**
 * Tests for v17 features: temporal validity, provenance, causal links, entry points.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory, SQLiteBackend } from "../../src/sdk.js";
import { indexDirectory, findEntryPoints } from "../../src/codegraph/engine.js";

describe("v17 features", () => {
  let tmpDir: string;
  let mem: Memory;
  let storage: SQLiteBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "remem-v17-"));
    const dbPath = join(tmpDir, "test.db");
    mem = new Memory({ dbPath });
    storage = new SQLiteBackend(dbPath);
  });

  afterEach(() => {
    mem.close();
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Temporal validity ──────────────────────────────────────────

  describe("temporal validity", () => {
    it("has valid_from and valid_until columns", () => {
      const cols = storage
        .getDatabase()
        .prepare("PRAGMA table_info(captures)")
        .all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("valid_from");
      expect(colNames).toContain("valid_until");
    });

    it("sets valid_from to createdAt on capture", async () => {
      const id = await mem.capture("DB is PostgreSQL v14", "decision", ["db"]);
      const row = storage
        .getDatabase()
        .prepare("SELECT valid_from, created_at FROM captures WHERE id = ?")
        .get(id) as { valid_from: number; created_at: number };
      expect(row.valid_from).toBe(row.created_at);
    });

    it("supersede sets valid_until on the loser", async () => {
      const id1 = await mem.capture("API endpoint is /v1/users", "decision", ["api"]);
      await new Promise((r) => setTimeout(r, 10));
      const id2 = await mem.capture("API endpoint is /v2/users", "decision", ["api"]);
      await storage.supersede(id1!, id2!);

      const loser = storage
        .getDatabase()
        .prepare("SELECT valid_until FROM captures WHERE id = ?")
        .get(id1) as { valid_until: number | null };
      expect(loser.valid_until).not.toBeNull();
      expect(loser.valid_until).toBeGreaterThan(0);
    });

    it("search filters out superseded facts past valid_until", async () => {
      const old = await mem.capture("API endpoint is /v1/users", "decision", ["api"]);
      await new Promise((r) => setTimeout(r, 10));
      const newer = await mem.capture("API endpoint is /v2/users", "decision", ["api"]);
      await storage.supersede(old!, newer!);

      const results = await mem.recall("API endpoint users", { limit: 10 });
      const foundOld = results.some((r) => r.entry.content.includes("/v1/users"));
      expect(foundOld).toBe(false);
      const foundNew = results.some((r) => r.entry.content.includes("/v2/users"));
      expect(foundNew).toBe(true);
    });

    it("winner has valid_until NULL (still valid)", async () => {
      const id1 = await mem.capture("Config value A", "decision", ["config"]);
      await new Promise((r) => setTimeout(r, 10));
      const id2 = await mem.capture("Config value B", "decision", ["config"]);
      await storage.supersede(id1!, id2!);

      const winner = storage
        .getDatabase()
        .prepare("SELECT valid_until FROM captures WHERE id = ?")
        .get(id2) as { valid_until: number | null };
      expect(winner.valid_until).toBeNull();
    });
  });

  // ─── Provenance ──────────────────────────────────────────────────

  describe("provenance", () => {
    it("has source_ref column", () => {
      const cols = storage
        .getDatabase()
        .prepare("PRAGMA table_info(captures)")
        .all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain("source_ref");
    });

    it("stores source_ref from metadata.source", async () => {
      const id = await mem.capture("Test content", "learning", ["test"], {
        metadata: { source: "bash:git status" },
      });
      const row = storage
        .getDatabase()
        .prepare("SELECT source_ref FROM captures WHERE id = ?")
        .get(id) as { source_ref: string | null };
      expect(row.source_ref).toBe("bash:git status");
    });

    it("source_ref is NULL when no metadata.source provided", async () => {
      const id = await mem.capture("No provenance", "learning", ["test"]);
      const row = storage
        .getDatabase()
        .prepare("SELECT source_ref FROM captures WHERE id = ?")
        .get(id) as { source_ref: string | null };
      expect(row.source_ref).toBeNull();
    });
  });

  // ─── Causal link auto-extraction ─────────────────────────────────

  describe("causal link auto-extraction", () => {
    it("creates cause-effect links for captures with causal language", async () => {
      const id1 = await mem.capture("Missing vitest config caused test failure", "error", ["test", "vitest"]);
      const id2 = await mem.capture("Added vitest.config.ts which fixed the tests", "task", ["test", "vitest"]);

      const links = storage
        .getDatabase()
        .prepare("SELECT * FROM memory_links WHERE link_type = 'cause-effect'")
        .all() as { from_id: string; to_id: string }[];
      expect(links.length).toBeGreaterThan(0);
    });

    it("does not create cause-effect links for non-causal captures", async () => {
      await mem.capture("The weather is nice today", "conversation", ["weather"]);
      await mem.capture("I like pizza", "conversation", ["food"]);

      const links = storage
        .getDatabase()
        .prepare("SELECT * FROM memory_links WHERE link_type = 'cause-effect'")
        .all() as { from_id: string; to_id: string }[];
      expect(links.length).toBe(0);
    });

    it("causal link direction: older capture is the cause", async () => {
      const id1 = await mem.capture("Missing config led to build failure", "error", ["build"]);
      await new Promise((r) => setTimeout(r, 10));
      const id2 = await mem.capture("Fixed config which resolved the build", "task", ["build"]);

      const links = storage
        .getDatabase()
        .prepare("SELECT * FROM memory_links WHERE link_type = 'cause-effect'")
        .all() as { from_id: string; to_id: string }[];
      // The older capture (id1) should be the cause (from_id)
      const causeLink = links.find((l) => l.from_id === id1 && l.to_id === id2);
      expect(causeLink).toBeDefined();
    });
  });

  // ─── CodeGraph entry points ─────────────────────────────────────

  describe("codegraph entry points", () => {
    let repoDir: string;
    let db: Database.Database;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "remem-cg-ep-"));
      db = new Database(":memory:");
      sqliteVec.load(db);
      db.exec(readFileSync(join(process.cwd(), "src/storage/schema.sql"), "utf-8"));
    });

    afterEach(() => {
      db.close();
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("finds main function as entry point", async () => {
      writeFileSync(join(repoDir, "main.ts"), `
export function main() { console.log("hello"); }
export function helper() { return 42; }
`);
      await indexDirectory(db, repoDir, repoDir);
      const eps = findEntryPoints(db, { repoPath: repoDir });
      const names = eps.map((e) => e.name);
      expect(names).toContain("main");
      expect(names).not.toContain("helper");
    });

    it("finds HTTP handler functions as entry points", async () => {
      writeFileSync(join(repoDir, "server.ts"), `
export function handleGetUsers(req: any, res: any) { return res.json(); }
export function handlePostUser(req: any, res: any) { return res.json(); }
export function helper() { return 1; }
`);
      await indexDirectory(db, repoDir, repoDir);
      const eps = findEntryPoints(db, { repoPath: repoDir });
      const names = eps.map((e) => e.name).sort();
      expect(names).toContain("handleGetUsers");
      expect(names).toContain("handlePostUser");
      expect(names).not.toContain("helper");
    });

    it("finds event handler functions (onXxx)", async () => {
      writeFileSync(join(repoDir, "events.ts"), `
export function onClick(event: Event) { console.log("clicked"); }
export function onLoad() { console.log("loaded"); }
export function processData(data: any) { return data; }
`);
      await indexDirectory(db, repoDir, repoDir);
      const eps = findEntryPoints(db, { repoPath: repoDir });
      const names = eps.map((e) => e.name).sort();
      expect(names).toContain("onClick");
      expect(names).toContain("onLoad");
      expect(names).not.toContain("processData");
    });

    it("finds Controller and Handler suffix patterns", async () => {
      writeFileSync(join(repoDir, "controllers.ts"), `
export class UserController { handle(req: any) { return req; } }
export function AuthHandler() { return true; }
export function utility() { return 0; }
`);
      await indexDirectory(db, repoDir, repoDir);
      const eps = findEntryPoints(db, { repoPath: repoDir });
      const names = eps.map((e) => e.name);
      expect(names).toContain("AuthHandler");
    });

    it("returns empty array for repo with no matches", async () => {
      writeFileSync(join(repoDir, "utils.ts"), `
export function helper() { return 42; }
export function utility() { return 0; }
`);
      await indexDirectory(db, repoDir, repoDir);
      const eps = findEntryPoints(db, { repoPath: repoDir });
      expect(eps.length).toBe(0);
    });
  });
});
