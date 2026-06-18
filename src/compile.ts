import { type BuildOptions, buildGraph, indexNodesByType, resolveManifestLinks } from "./build";
import type { Graph, Manifest, Node, SourceKind, SourceProvenance } from "./types";
import type { SourceInput } from "./weave";

export interface SourceDiagnostic {
  source: string;
  kind?: SourceKind;
  nodeCount: number;
  nodesByType: Record<string, number>;
}

export interface UnresolvedLinkDiagnostic {
  from: string;
  fromType: string;
  source?: SourceProvenance;
  relation: string;
  sourceField: string;
  targetType: string;
  value: string;
}

export interface GraphCompileDiagnostics {
  sourceCounts: SourceDiagnostic[];
  nodesByType: Record<string, number>;
  duplicateRefs: string[];
  unresolvedLinks: UnresolvedLinkDiagnostic[];
}

export interface CompileGraphOptions extends BuildOptions {
  maxUnresolvedLinks?: number;
}

export interface CompileGraphResult {
  graph: Graph;
  nodes: Node[];
  diagnostics: GraphCompileDiagnostics;
}

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

export function projectSourceInputs(inputs: readonly SourceInput<any>[]): Node[] {
  const nodes: Node[] = [];
  for (const { source, records } of inputs) nodes.push(...source.project(records));
  return nodes;
}

export function diagnoseGraphInputs(
  nodes: readonly Node[],
  manifest: Manifest,
  opts: { maxUnresolvedLinks?: number } = {},
): GraphCompileDiagnostics {
  const maxUnresolved = opts.maxUnresolvedLinks ?? 50;
  const sourceMap = new Map<string, SourceDiagnostic>();
  const nodesByType: Record<string, number> = {};
  const seenRefs = new Set<string>();
  const duplicateRefs = new Set<string>();

  for (const n of nodes) {
    tally(nodesByType, n.type);
    if (seenRefs.has(n.ref)) duplicateRefs.add(n.ref);
    seenRefs.add(n.ref);

    const sourceName = n.source?.source ?? "unknown";
    const current =
      sourceMap.get(sourceName) ??
      ({
        source: sourceName,
        ...(n.source?.kind ? { kind: n.source.kind } : {}),
        nodeCount: 0,
        nodesByType: {},
      } satisfies SourceDiagnostic);
    current.nodeCount += 1;
    tally(current.nodesByType, n.type);
    sourceMap.set(sourceName, current);
  }

  // Same index + resolution pass the builder uses — so an "unresolved" link here is
  // exactly an edge `buildGraph` couldn't draw, never a divergent re-implementation.
  const unresolvedLinks: UnresolvedLinkDiagnostic[] = [];
  const noop = () => {};
  resolveManifestLinks(nodes, manifest, indexNodesByType(nodes), noop, (n, rule, value) => {
    if (unresolvedLinks.length >= maxUnresolved) return;
    unresolvedLinks.push({
      from: n.ref,
      fromType: n.type,
      ...(n.source ? { source: n.source } : {}),
      relation: rule.relation,
      sourceField: rule.sourceField,
      targetType: rule.to,
      value,
    });
  });

  return {
    sourceCounts: [...sourceMap.values()],
    nodesByType,
    duplicateRefs: [...duplicateRefs],
    unresolvedLinks,
  };
}

export function compileGraph(
  inputs: readonly SourceInput<any>[],
  manifest: Manifest,
  opts: CompileGraphOptions = {},
): CompileGraphResult {
  const nodes = projectSourceInputs(inputs);
  const graph = buildGraph(nodes, manifest, opts);
  const diagnostics = diagnoseGraphInputs(nodes, manifest, {
    ...(opts.maxUnresolvedLinks !== undefined ? { maxUnresolvedLinks: opts.maxUnresolvedLinks } : {}),
  });
  return { graph, nodes, diagnostics };
}
