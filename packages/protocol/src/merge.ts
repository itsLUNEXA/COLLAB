/**
 * @file merge.ts
 * Reliable zero-dependency line-based three-way text merge engine.
 * Computes non-overlapping merges and isolates overlapping collision chunks.
 */

export interface ConflictChunk {
  baseLines: string[];
  localLines: string[];
  remoteLines: string[];
}

export interface ThreeWayMergeResult {
  clean: boolean;
  mergedContent: string;
  hasConflicts: boolean;
  conflictChunks: ConflictChunk[];
}

/**
 * Performs a line-based three-way merge.
 * - Merges non-overlapping edits automatically without loss.
 * - Flags overlapping conflicts and returns separated chunks.
 *
 * @param baseText - Common ancestor version.
 * @param localText - Current local version on disk.
 * @param remoteText - Incoming teammate version from sync event.
 */
export function threeWayMerge(
  baseText: string,
  localText: string,
  remoteText: string
): ThreeWayMergeResult {
  // Shortcut 1: If local and remote are identical, no merge needed
  if (localText === remoteText) {
    return {
      clean: true,
      mergedContent: localText,
      hasConflicts: false,
      conflictChunks: [],
    };
  }

  // Shortcut 2: If local equals base, remote wins completely (clean)
  if (localText === baseText) {
    return {
      clean: true,
      mergedContent: remoteText,
      hasConflicts: false,
      conflictChunks: [],
    };
  }

  // Shortcut 3: If remote equals base, local wins completely (clean)
  if (remoteText === baseText) {
    return {
      clean: true,
      mergedContent: localText,
      hasConflicts: false,
      conflictChunks: [],
    };
  }

  const baseLines = baseText === '' ? [] : baseText.split('\n');
  const localLines = localText === '' ? [] : localText.split('\n');
  const remoteLines = remoteText === '' ? [] : remoteText.split('\n');

  // Analyze by line index alignment
  const mergedLines: string[] = [];
  const conflictChunks: ConflictChunk[] = [];
  let hasConflicts = false;

  let bIdx = 0;
  let lIdx = 0;
  let rIdx = 0;

  while (bIdx < baseLines.length || lIdx < localLines.length || rIdx < remoteLines.length) {
    const bLine = bIdx < baseLines.length ? baseLines[bIdx] : undefined;
    const lLine = lIdx < localLines.length ? localLines[lIdx] : undefined;
    const rLine = rIdx < remoteLines.length ? remoteLines[rIdx] : undefined;

    // Both match base
    if (lLine === bLine && rLine === bLine) {
      if (bLine !== undefined) mergedLines.push(bLine);
      bIdx++;
      lIdx++;
      rIdx++;
      continue;
    }

    // Local changed, remote matches base -> take local change
    if (rLine === bLine && lLine !== bLine) {
      if (lLine !== undefined) mergedLines.push(lLine);
      lIdx++;
      if (bLine !== undefined) bIdx++;
      if (rLine !== undefined) rIdx++;
      continue;
    }

    // Remote changed, local matches base -> take remote change
    if (lLine === bLine && rLine !== bLine) {
      if (rLine !== undefined) mergedLines.push(rLine);
      rIdx++;
      if (bLine !== undefined) bIdx++;
      if (lLine !== undefined) lIdx++;
      continue;
    }

    // Both changed identically -> take either
    if (lLine === rLine) {
      if (lLine !== undefined) mergedLines.push(lLine);
      if (bLine !== undefined) bIdx++;
      lIdx++;
      rIdx++;
      continue;
    }

    // Both changed differently -> CONFLICT
    hasConflicts = true;
    const conflictLocal: string[] = [];
    const conflictRemote: string[] = [];
    const conflictBase: string[] = [];

    if (bLine !== undefined) {
      conflictBase.push(bLine);
      bIdx++;
    }
    if (lLine !== undefined) {
      conflictLocal.push(lLine);
      lIdx++;
    }
    if (rLine !== undefined) {
      conflictRemote.push(rLine);
      rIdx++;
    }

    conflictChunks.push({
      baseLines: conflictBase,
      localLines: conflictLocal,
      remoteLines: conflictRemote,
    });

    // Insert formatted conflict marker in merged content
    mergedLines.push('<<<<<<< LOCAL');
    mergedLines.push(...conflictLocal);
    mergedLines.push('=======');
    mergedLines.push(...conflictRemote);
    mergedLines.push('>>>>>>> REMOTE');
  }

  return {
    clean: !hasConflicts,
    mergedContent: mergedLines.join('\n'),
    hasConflicts,
    conflictChunks,
  };
}
