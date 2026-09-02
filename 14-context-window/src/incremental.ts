/**
 * Incremental running summary: the production shape of summarize-evicted.
 *
 * The stateless policy re-summarizes every evicted turn from scratch on every
 * call, which makes it an upper bound in two directions at once: it re-reads
 * text that scales with the whole conversation, and it can bring back a
 * sentence an earlier compression dropped. This assembler does neither.
 * It carries state across calls: once a turn is folded into the running
 * summary it stays folded, and each compaction sees only the previous summary
 * plus the newly folded turns. A sentence the packer drops is gone for good.
 *
 * Eviction, budgeting, rendering, and packing all reuse the stateless
 * policy's arithmetic (fillTail, finish, SUMMARY_HEADER, summarize), so on
 * its very first compaction — empty summary, whole evicted prefix in the
 * pool — this assembler produces the stateless policy's context exactly.
 * Everything after that is where the two shapes diverge, and the divergence
 * is the measurement.
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { luhnScorer, rarityScorer, summarize, type SentenceScorer } from "./salience.js";
import { sentences } from "./text.js";
import {
  fillTail,
  finish,
  renderTurn,
  SUMMARY_HEADER,
  type AssembledContext,
  type Turn,
} from "./policies.js";

export interface IncrementalConfig {
  /** Fraction of the post-pinned room reserved for the summary block. */
  summaryShare?: number;
  /** Which salience definition ranks sentences at compaction time. */
  summarizer?: "luhn" | "rarity";
}

export interface IncrementalCallStats {
  /** Tokens of the sentences handed to the scorer this call (0 when no compaction ran). */
  workTokens: number;
  /** True when the scorer ran (new turns folded, or a shrink repack). */
  compacted: boolean;
  /** Sentences in this call's pool that did not survive the packing. */
  droppedSentences: number;
  /** True when the compaction was forced by a smaller budget, not new evictions. */
  shrinkRepack: boolean;
}

export class IncrementalAssembler {
  private readonly share: number;
  private readonly scorer: SentenceScorer;
  private foldedCount = 0;
  private summary: string[] = [];

  constructor(config: IncrementalConfig = {}) {
    this.share = config.summaryShare ?? 0.25;
    this.scorer = (config.summarizer ?? "luhn") === "luhn" ? luhnScorer() : rarityScorer();
  }

  /** Number of history turns permanently folded into the summary so far. */
  foldedTurns(): number {
    return this.foldedCount;
  }

  /** The running summary's sentences, oldest first. */
  summarySentences(): readonly string[] {
    return this.summary;
  }

  /** Token size of the running summary, in the packer's own arithmetic. */
  summaryTokens(): number {
    return this.summary.reduce((n, s) => n + estimateTokens(s), 0);
  }

  assemble(
    system: string,
    history: readonly Turn[],
    currentUser: Turn,
    budget: number,
  ): { ctx: AssembledContext; stats: IncrementalCallStats } {
    const noWork: IncrementalCallStats = { workTokens: 0, compacted: false, droppedSentences: 0, shrinkRepack: false };
    const baseTokens = estimateTokens(system) + estimateTokens(renderTurn(currentUser));
    if (baseTokens > budget) {
      // Pinned parts alone blow the budget: nothing is folded, state unchanged.
      return { ctx: finish(system, null, [], currentUser, true, [...this.summary]), stats: noWork };
    }
    const room = budget - baseTokens;

    // Before anything has ever been folded, behave exactly like the stateless
    // policy: keep the whole history when it fits, no summary block.
    const unfolded = history.slice(this.foldedCount);
    if (this.foldedCount === 0) {
      const fullFit = fillTail(unfolded, room);
      if (fullFit.kept.length === unfolded.length) {
        return { ctx: finish(system, null, fullFit.kept, currentUser, false, []), stats: noWork };
      }
    }

    const summaryBudget = Math.floor(room * this.share);
    const headerCost = estimateTokens(SUMMARY_HEADER);
    const packBudget = Math.max(0, summaryBudget - headerCost);
    const { kept } = fillTail(unfolded, room - summaryBudget);
    const newlyFolded = unfolded.slice(0, unfolded.length - kept.length);
    this.foldedCount += newlyFolded.length;

    const stats: IncrementalCallStats = { ...noWork };
    if (newlyFolded.length > 0) {
      const pool = [...this.summary, ...newlyFolded.flatMap((t) => sentences(t.text))];
      stats.workTokens = pool.reduce((n, s) => n + estimateTokens(s), 0);
      stats.compacted = true;
      this.summary = summarize(pool, packBudget, this.scorer);
      stats.droppedSentences = pool.length - this.summary.length;
    } else if (this.summaryTokens() > packBudget) {
      // A tighter call than the one that packed this summary: repack from the
      // summary's own sentences. Whatever falls out now is gone permanently,
      // even if the very next call would have had room for it.
      const pool = this.summary;
      stats.workTokens = pool.reduce((n, s) => n + estimateTokens(s), 0);
      stats.compacted = true;
      stats.shrinkRepack = true;
      this.summary = summarize(pool, packBudget, this.scorer);
      stats.droppedSentences = pool.length - this.summary.length;
    }

    const summaryBlock = this.summary.length > 0 ? `${SUMMARY_HEADER} ${this.summary.join(" ")}` : null;
    const ctx = finish(system, summaryBlock, kept, currentUser, false, [...this.summary]);
    if (stats.compacted) ctx.summaryWorkTokens = stats.workTokens;
    return { ctx, stats };
  }
}
