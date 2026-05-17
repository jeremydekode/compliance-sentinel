// Minimal word-level diff for highlighting before/after text changes.
// Returns segments that can be rendered with markup.

export type DiffSegment =
  | { type: "common"; text: string }
  | { type: "removed"; text: string }
  | { type: "added"; text: string };

function tokenize(s: string): string[] {
  // Split into words + whitespace + punctuation, preserving them as separate tokens
  return s.match(/\s+|\w+|[^\w\s]+/g) ?? [];
}

// Longest Common Subsequence on token arrays
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function collapseSegments(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

export function diffOld(oldText: string, newText: string): DiffSegment[] {
  const a = tokenize(oldText ?? "");
  const b = tokenize(newText ?? "");
  const dp = lcsMatrix(a, b);
  const segs: DiffSegment[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      segs.unshift({ type: "common", text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Token only in NEW — skip when rendering OLD
      j--;
    } else if (i > 0) {
      segs.unshift({ type: "removed", text: a[i - 1] });
      i--;
    }
  }
  return collapseSegments(segs);
}

export function diffNew(oldText: string, newText: string): DiffSegment[] {
  const a = tokenize(oldText ?? "");
  const b = tokenize(newText ?? "");
  const dp = lcsMatrix(a, b);
  const segs: DiffSegment[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      segs.unshift({ type: "common", text: b[j - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segs.unshift({ type: "added", text: b[j - 1] });
      j--;
    } else if (i > 0) {
      // Token only in OLD — skip when rendering NEW
      i--;
    }
  }
  return collapseSegments(segs);
}
