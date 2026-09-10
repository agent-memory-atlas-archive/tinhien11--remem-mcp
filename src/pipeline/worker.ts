/**
 * Background pipeline worker — auto-distills L0 captures into L1 atoms,
 * L2 scenarios, and L3 persona without requiring the agent to call tools.
 *
 * Adapted from TencentDB Agent Memory PipelineWorker concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * Zero-LLM-cost: uses RuleBasedAtomPipeline for L1 extraction.
 * L2 auto-consolidation groups atoms by topic keyword (5+ atoms → scenario).
 * L3 auto-persona detects repeated tags in captures (2+ same tag → persona trait).
 */

import type { Embedder } from "../embedding/types.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import { generateId } from "../utils/ulid.js";
import { RuleBasedAtomPipeline } from "./atom.js";
import type { CaptureInput, PipelineContext } from "./types.js";

export interface WorkerOptions {
  dbPath: string;
  /** Min atoms on same topic to trigger L2 consolidation. Default: 5 */
  consolidateThreshold?: number;
  /** Min captures with same tag to trigger L3 persona update. Default: 2 */
  personaThreshold?: number;
  /** Max captures to process per run. Default: 50 */
  batchSize?: number;
  /** Team/user scope. Default: "default" */
  teamId?: string;
  userId?: string;
  /** Session key to stamp on created scenarios (hash(cwd)). Default: none (NULL). */
  sessionKey?: string;
}

export interface WorkerResult {
  capturesProcessed: number;
  atomsExtracted: number;
  scenariosCreated: number;
  personaUpdated: boolean;
  errors: string[];
}

/**
 * Process unprocessed L0 captures through the full L0→L1→L2→L3 pipeline.
 * Intended to run on Stop hook or via CLI `remem-mcp worker-run`.
 */
export async function runPipelineWorker(
  opts: WorkerOptions,
  embedder: Embedder,
): Promise<WorkerResult> {
  const storage = new SQLiteBackend(opts.dbPath);
  const result: WorkerResult = {
    capturesProcessed: 0,
    atomsExtracted: 0,
    scenariosCreated: 0,
    personaUpdated: false,
    errors: [],
  };

  try {
    const teamId = opts.teamId ?? "default";
    const userId = opts.userId ?? "default";
    const batchSize = opts.batchSize ?? 50;
    const consolidateThreshold = opts.consolidateThreshold ?? 5;
    const personaThreshold = opts.personaThreshold ?? 2;

    // 1. L0→L1: Extract atoms from recent captures that don't have atoms yet
    const pipeline = new RuleBasedAtomPipeline();
    const ctx: PipelineContext = {
      storage,
      embedder,
      sessionKey: "worker",
    };

    // Fetch recent captures (L0) that don't have atoms yet.
    // Handle NULL team_id (legacy captures) and explicit team_id.
    const db = (storage as unknown as { db: import("better-sqlite3").Database }).db;
    const captures = db
      .prepare(
        `SELECT id, content, type, tags, session_key, team_id, user_id, created_at
         FROM captures
         WHERE (team_id = ? OR team_id IS NULL OR team_id = 'default')
           AND id NOT IN (SELECT DISTINCT capture_id FROM atoms)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(teamId, batchSize) as Array<{
      id: string;
      content: string;
      type: string;
      tags: string | null;
      session_key: string;
      team_id: string | null;
      user_id: string | null;
    }>;

    for (const cap of captures) {
      try {
        const input: CaptureInput = {
          id: cap.id,
          content: cap.content,
          type: cap.type,
          tags: cap.tags ? JSON.parse(cap.tags) : [],
          sessionKey: cap.session_key,
          teamId: cap.team_id ?? undefined,
          userId: cap.user_id ?? undefined,
        };
        const output = await pipeline.process(input, ctx);
        if (output.atoms) {
          result.atomsExtracted += output.atoms.length;
        }
        result.capturesProcessed++;
      } catch (err) {
        result.errors.push(`capture ${cap.id}: ${err}`);
      }
    }

    // 2. L1→L2: Auto-consolidate atoms by topic (tag-based, fallback to keyword)
    // Filter atoms by session_key so scenarios contain only current-project facts.
    // Without this filter, atoms from other projects leak into AZR scenarios.
    const atoms = await storage.listAtoms({ limit: 200, sessionKey: opts.sessionKey });
    const groups = new Map<string, typeof atoms>();
    for (const a of atoms) {
      // Group by significant keywords in fact (not just first word)
      const words = a.fact
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3);
      // Use first 2 significant words as key — more stable grouping
      const key = words.slice(0, 2).join("-") || "misc";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }

    // Check existing scenarios to avoid duplicates.
    // Only check scenarios for the current session_key — legacy NULL session_key
    // scenarios must not block creation of new project-scoped scenarios.
    const existingScenarios = await storage.listScenarios({
      limit: 100,
      sessionKey: opts.sessionKey,
    });
    const existingTopics = new Set(existingScenarios.flatMap((s) => s.personaTags ?? []));

    for (const [topic, groupAtoms] of groups) {
      if (groupAtoms.length < consolidateThreshold) continue;
      if (existingTopics.has(topic)) continue; // skip if scenario already exists for topic
      const summary = buildScenarioSummary(topic, groupAtoms);
      const id = generateId();
      await storage.putScenario({
        id,
        atomIds: groupAtoms.map((a) => a.id),
        summary,
        personaTags: [topic],
        createdAt: Date.now(),
        sessionKey: opts.sessionKey,
      });
      result.scenariosCreated++;
    }

    // 3. L2→L3: Auto-persona from repeated tags in captures
    // Filter by session_key so persona only reflects current-project tags.
    // Without this filter, tags from other projects (e.g. bugbounty, doordash)
    // pollute the persona for the current project.
    const tagCounts = db
      .prepare(
        `SELECT tags FROM captures
         WHERE (team_id = ? OR team_id IS NULL OR team_id = 'default')
           AND session_key = ?
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(teamId, opts.sessionKey) as Array<{ tags: string | null }>;

    const tagFreq = new Map<string, number>();
    for (const row of tagCounts) {
      if (!row.tags) continue;
      try {
        const tags = JSON.parse(row.tags) as string[];
        for (const t of tags) {
          tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
        }
      } catch {
        // skip malformed tags
      }
    }

    // Recompute tag-count portion of persona from scratch each run.
    // Previous approach used !existingContent.includes(tag) which froze counts
    // forever once a tag appeared. Now we preserve manual traits (lines not
    // ending with "occurrences") and replace the auto-generated tag counts.
    const existingPersona = await storage.readPersona(teamId, "default", userId, opts.sessionKey);
    const existingContent = existingPersona?.content ?? "";

    // Preserve manual traits — lines that don't end with "occurrences"
    const manualTraits = existingContent
      .split("\n")
      .filter((line) => line.trim() && !line.trim().endsWith("occurrences"));

    // Recompute top tags with current counts
    const topTags = Array.from(tagFreq.entries())
      .filter(([, count]) => count >= personaThreshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => `${tag}: ${count} occurrences`);

    if (topTags.length > 0) {
      const updatedContent = [...manualTraits, ...topTags].join("\n");
      await storage.writePersona(teamId, "default", userId, updatedContent, opts.sessionKey);
      result.personaUpdated = true;
    }
  } finally {
    storage.close();
  }

  return result;
}

/**
 * Build a concise scenario summary from a group of atoms.
 *
 * Dedupes similar facts (e.g., multiple "Error: <same cmd> fails" atoms),
 * truncates each to ~80 chars, and caps the total at ~250 chars to keep
 * the L2 injection budget around 100 tokens.
 */
function buildScenarioSummary(
  topic: string,
  atoms: Array<{ fact: string }>,
): string {
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const a of atoms) {
    // Normalize for dedup: strip "Error: " prefix, lowercase, take first 60 chars
    const normalized = a.fact
      .replace(/^Error:\s*/i, "")
      .toLowerCase()
      .slice(0, 60);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    // Truncate each fact to 80 chars
    facts.push(a.fact.slice(0, 80));
    if (facts.length >= 5) break;
  }
  const body = facts.join("; ");
  return `${topic}: ${body}`.slice(0, 300);
}
