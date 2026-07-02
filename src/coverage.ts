/**
 * Source coverage — the honesty layer for graphs over unreliable sources.
 *
 * A woven graph is only as complete as the reads that fed it. Over heterogeneous
 * sources (REST APIs that rate-limit, DBs that time out, list endpoints that cap at
 * N rows) a leg can fail or truncate — and a graph built from partial inputs LIES by
 * omission: an invoice looks orphaned, an edge looks dangling, a count looks small,
 * when the truth is "the orders read failed". Coverage makes that distinction
 * first-class: the consumer reports how each source read went, and weave's health,
 * diagnostics, and agent toolkit interpret structural findings THROUGH it.
 *
 * Pure, like everything here: weave never does I/O. You sweep your sources however
 * you like and hand the outcome in.
 */

import type { InvariantFinding } from "./health.js";
import type { NodeType } from "./types.js";

/** How one source read went. One entry per swept leg (a leg is whatever unit the
 *  consumer sweeps by — a capability, an endpoint, a table). */
export interface SourceCoverage {
  /** Stable id the consumer can act on — e.g. "zoho_inventory.invoices". A resweep
   *  remedy hands this exact id back to the consumer's sink. */
  source: string;
  /** Node types this source feeds — the attribution key. A structural finding that
   *  touches one of these types while this leg errored/truncated is a coverage
   *  artifact, not a data fact. */
  types: NodeType[];
  /** Whether a read was attempted. `false` means "skipped by design" (the consumer's
   *  policy — e.g. a surface only gathered point-wise); a FAILED attempt is
   *  `swept: true` with `errors`. */
  swept: boolean;
  /** Rows/records the read returned. */
  count?: number;
  /** The read hit a cap — more rows exist than were projected. The graph is partial. */
  truncated?: boolean;
  /** Failures captured during the read. Non-empty ⇒ the leg is partial or empty. */
  errors?: string[];
}

/** A coverage report, or a function returning one (paired with a live graph source,
 *  so tools see the coverage of the sweep that produced the graph they read). */
export type CoverageSource = SourceCoverage[] | (() => SourceCoverage[]);

export function resolveCoverage(src: CoverageSource | undefined): SourceCoverage[] | undefined {
  return typeof src === "function" ? src() : src;
}

/** True when every ATTEMPTED leg came back whole: no errors, no truncation.
 *  Deliberately-skipped legs (`swept: false`) don't count against completeness —
 *  skipping is the consumer's policy, not a failure. */
export function coverageComplete(coverage: readonly SourceCoverage[]): boolean {
  return coverage.every((c) => !c.swept || (!c.truncated && !(c.errors?.length)));
}

/** The coverage legs that feed a node type and did NOT come back whole — the
 *  attribution lookup behind "is this finding a coverage artifact?". */
export function impairedLegsForType(
  coverage: readonly SourceCoverage[],
  type: NodeType,
): SourceCoverage[] {
  return coverage.filter(
    (c) => c.swept && c.types.includes(type) && (Boolean(c.truncated) || Boolean(c.errors?.length)),
  );
}

/** Turn a coverage report into findings, one per impaired leg — the same finding
 *  channel as the structural invariants, so ONE diagnose pass sees both. `refs`
 *  carries the affected node TYPES (coverage findings are about legs, not nodes);
 *  `source` carries the leg id a resweep can act on. */
export function checkCoverage(coverage: readonly SourceCoverage[]): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const leg of coverage) {
    if (!leg.swept) continue;
    if (leg.errors?.length) {
      findings.push({
        code: "source_error",
        severity: "error",
        message:
          `Source "${leg.source}" failed while sweeping (${leg.errors.length} error(s): ` +
          `${leg.errors.slice(0, 3).join(" | ")}). Every ${leg.types.join("/")} count, cluster and ` +
          `join in this graph may be missing records from it.`,
        refs: [...leg.types],
        source: leg.source,
      });
    } else if (leg.truncated) {
      findings.push({
        code: "source_truncated",
        severity: "warn",
        message:
          `Source "${leg.source}" hit its read cap — more ${leg.types.join("/")} rows exist than were ` +
          `projected. Counts are floors and absences are unproven until a fuller sweep.`,
        refs: [...leg.types],
        source: leg.source,
      });
    }
  }
  return findings;
}
