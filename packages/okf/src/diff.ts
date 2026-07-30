import { compare } from './definition.js';
import type { OkfBuildManifest } from './compiler.js';

export interface OkfBuildDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly empty: boolean;
}

/** Compares output hashes only; build identifiers do not make equal files appear changed. */
export function diffOkfBuilds(previous: OkfBuildManifest, next: OkfBuildManifest): OkfBuildDiff {
  const before = new Map(previous.files.map((item) => [item.path, item.sha256]));
  const after = new Map(next.files.map((item) => [item.path, item.sha256]));
  const added = [...after.keys()].filter((path) => !before.has(path)).sort(compare);
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort(compare);
  const changed = [...after.keys()]
    .filter((path) => before.has(path) && before.get(path) !== after.get(path))
    .sort(compare);
  const unchanged = [...after.keys()]
    .filter((path) => before.get(path) === after.get(path))
    .sort(compare);
  return {
    added,
    removed,
    changed,
    unchanged,
    empty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}
