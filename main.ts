// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's text as lines: its line break, its lines, whether it ends with a break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  if (nl < 0) return { br: '\n', lines: [text], final: false };
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order: used to print R lines instead of D and A. */
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A block of old lines O replaced by new lines N. Context lines of N are written as
 * the file's own matched lines; newOldIdx maps each context line of N to its index in O. */
interface Block {
  old: string[];
  nw: string[];
  oldCtx: boolean[];
  newCtx: boolean[];
  newOldIdx: number[];
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i >= from where O matches the file's lines at one tier; occurrences may overlap. */
function occurrencesAt(file: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const want = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once
 * at or after `from`, with every such position. */
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(file, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The replacement lines for a block matched at `pos` at `tier`: context lines of N are
 * the file's own matched lines; at tier 2 every other line of N is re-indented from O's
 * first line's leading whitespace to the file's first matched line's. */
function buildReplacement(file: string[], pos: number, tier: number, b: Block): string[] {
  const out: string[] = [];
  const p = b.old.length > 0 ? leadingWS(b.old[0]!) : '';
  const f = pos < file.length ? leadingWS(file[pos]!) : '';
  for (let j = 0; j < b.nw.length; j++) {
    if (b.newCtx[j]) {
      out.push(file[pos + b.newOldIdx[j]!]!);
      continue;
    }
    const line = b.nw[j]!;
    if (tier === 2 && b.old.length > 0 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) {
      out.push(f + line.slice(p.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** The path after `--- ` or `+++ `: the text after the four characters, up to the first
 * tab, with surrounding spaces removed, a leading a/ or b/ removed; /dev/null means no file. */
function patchPath(raw: string): string | null {
  let p = raw.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

interface HunkLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line at once. */
  backslash: boolean;
  /** The patch line this body line came from. */
  raw: string;
}

interface Hunk {
  /** The hunk header's old start line, 1-based. */
  a: number;
  body: HunkLine[];
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  /** A `--- ` / `+++ ` pair already named this section's paths. */
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function hunkBlock(h: Hunk): Block {
  const old: string[] = [];
  const nw: string[] = [];
  const oldCtx: boolean[] = [];
  const newCtx: boolean[] = [];
  const newOldIdx: number[] = [];
  for (const l of h.body) {
    if (l.kind === 'ctx') {
      old.push(l.text);
      oldCtx.push(true);
      nw.push(l.text);
      newCtx.push(true);
      newOldIdx.push(old.length - 1);
    } else if (l.kind === 'old') {
      old.push(l.text);
      oldCtx.push(false);
    } else {
      nw.push(l.text);
      newCtx.push(false);
      newOldIdx.push(-1);
    }
  }
  return { old, nw, oldCtx, newCtx, newOldIdx };
}

/** The hunk's last context or `+` line, and whether a `\` line follows it at once. */
function lastCtxOrNew(h: Hunk): { found: boolean; backslash: boolean } {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const l = h.body[k]!;
    if (l.kind === 'ctx' || l.kind === 'new') return { found: true, backslash: l.backslash };
  }
  return { found: false, backslash: false };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    for (const p of [sec.oldPath, sec.newPath]) {
      if (p === undefined || p === null) continue;
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = sec.oldPath === null || sec.newFile;
    const isDelete = sec.newPath === null || sec.deletedFile;
    if (isCreate) {
      const np = sec.newPath;
      if (np === null || np === undefined) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        for (const l of h.body) {
          if (l.kind === 'new') {
            plus.push(l.text);
            lastPlusBackslash = l.backslash;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = sec.oldPath;
      if (op === null || op === undefined) return;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let f = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const b = hunkBlock(h);
      const last = lastCtxOrNew(h);
      if (b.old.length === 0) {
        const ins = Math.max(0, Math.min(h.a + d, f.lines.length));
        const touchesEnd = ins === f.lines.length;
        const lines = [...f.lines.slice(0, ins), ...b.nw, ...f.lines.slice(ins)];
        f = { br: f.br, lines, final: touchesEnd ? !last.backslash : f.final };
        d += b.nw.length;
      } else {
        const found = findTier(f.lines, b.old, strict, 0);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        for (const p of found.pos) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const touchesEnd = best + b.old.length === f.lines.length;
        const rep = buildReplacement(f.lines, best, found.tier, b);
        const lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + b.old.length)];
        f = { br: f.br, lines, final: touchesEnd ? !last.backslash : f.final };
        d += b.nw.length - b.old.length;
      }
    }
    const rendered = renderFile(f);
    if (isMove) {
      tree.now.set(np, rendered);
      tree.now.set(op, null);
      tree.moves.push({ from: op, to: np });
    } else {
      tree.now.set(op, rendered);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let seenHunk = false;
  let curHunk: Hunk | null = null;

  const endBody = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === 'ctx' && blank(last.raw)) curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || line.startsWith('@@') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
        let kind: 'ctx' | 'old' | 'new';
        let text: string;
        if (line === '') {
          kind = 'ctx';
          text = '';
        } else if (line.startsWith(' ')) {
          kind = 'ctx';
          text = line.slice(1);
        } else if (line.startsWith('-')) {
          kind = 'old';
          text = line.slice(1);
        } else {
          kind = 'new';
          text = line.slice(1);
        }
        curHunk.body.push({ kind, text, backslash: false, raw: line });
        i++;
        continue;
      } else if (line.startsWith('\\')) {
        const body = curHunk.body;
        if (body.length > 0) body[body.length - 1]!.backslash = true;
        i++;
        continue;
      } else {
        endBody();
        i++;
        continue;
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, newFile: false, deletedFile: false, hunks: [] };
      seenHunk = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = patchPath(line);
      const newP = patchPath(lines[i + 1]!);
      if (cur !== null && !cur.hasPair && !seenHunk) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      } else {
        if (cur !== null) sections.push(cur);
        cur = { oldPath: oldP, newPath: newP, hasPair: true, newFile: false, deletedFile: false, hunks: [] };
        seenHunk = false;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      seenHunk = true;
      i++;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ') && !cur.hasPair) {
        cur.newPath = patchPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ') && !cur.hasPair) {
        cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ') && !cur.hasPair) {
        cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  endBody();
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = parseFile(before);
      const found = findTier(f.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const block: Block = { old: oldLines, nw: newLines, oldCtx: [], newCtx: [], newOldIdx: [] };
      const repLines = buildReplacement(f.lines, found.pos[0]!, found.tier, block);
      const out = [...f.lines.slice(0, found.pos[0]!), ...repLines, ...f.lines.slice(found.pos[0]! + oldLines.length)];
      tree.now.set(p, renderFile({ br: f.br, lines: out, final: f.final }));
    });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface V4AChunk {
  /** Null means no anchor. */
  anchor: string | null;
  body: string[];
  /** Ended by a `*** End of File` line. */
  eof: boolean;
}

function v4aChunkBlock(body: string[]): Block {
  const old: string[] = [];
  const nw: string[] = [];
  const oldCtx: boolean[] = [];
  const newCtx: boolean[] = [];
  const newOldIdx: number[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      old.push(t);
      oldCtx.push(true);
      nw.push(t);
      newCtx.push(true);
      newOldIdx.push(old.length - 1);
    } else if (l.startsWith('-')) {
      old.push(l.slice(1));
      oldCtx.push(false);
    } else if (l.startsWith('+')) {
      nw.push(l.slice(1));
      newCtx.push(false);
      newOldIdx.push(-1);
    } else {
      old.push('');
      oldCtx.push(true);
      nw.push('');
      newCtx.push(true);
      newOldIdx.push(old.length - 1);
    }
  }
  return { old, nw, oldCtx, newCtx, newOldIdx };
}

function v4aSectionEdit(kind: string, path: string, raw: string[], startLineNo: number, strict: boolean): Edit {
  if (kind === 'Add File') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${startLineNo + 1 + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'Delete File') {
    if (raw.length > 0) throw new Exit2(`error: parse ${startLineNo + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let curChunk: V4AChunk | null = null;
  let firstChunkStarted = false;
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    const ln = startLineNo + 1 + idx;
    if (l.startsWith('@@')) {
      if (curChunk !== null) chunks.push(curChunk);
      curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
      firstChunkStarted = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${ln}`);
      curChunk.eof = true;
      chunks.push(curChunk);
      curChunk = null;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${ln}`);
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (curChunk === null) {
        if (firstChunkStarted) throw new Exit2(`error: parse ${ln}`);
        curChunk = { anchor: null, body: [], eof: false };
        firstChunkStarted = true;
      }
      curChunk.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (curChunk !== null) chunks.push(curChunk);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLineNo}`);
  const to = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const anchor = findTier(f.lines, [ch.anchor], strict, cursor);
        if (anchor === null) throw new Fail('no-match', path);
        cursor = anchor.pos[0]! + 1;
      }
      const block = v4aChunkBlock(ch.body);
      if (block.old.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, ins), ...block.nw, ...f.lines.slice(ins)];
        f = { br: f.br, lines, final: f.final };
        cursor = ins + block.nw.length;
      } else {
        const found = findTier(f.lines, block.old, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let positions = found.pos;
        if (ch.eof) positions = positions.filter((p) => p + block.old.length === f.lines.length);
        if (positions.length === 0) throw new Fail('no-match', path);
        const pos = positions[0]!;
        const rep = buildReplacement(f.lines, pos, found.tier, block);
        const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + block.old.length)];
        f = { br: f.br, lines, final: f.final };
        cursor = pos + rep.length;
      }
    }
    const rendered = renderFile(f);
    if (to !== null) {
      tree.now.set(to, rendered);
      tree.now.set(path, null);
      tree.moves.push({ from: path, to });
    } else {
      tree.now.set(path, rendered);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const startLineNo = i + 1;
    let j = i + 1;
    const raw: string[] = [];
    while (j < last) {
      const l = lines[j]!;
      if (/^\*\*\* (Add File|Delete File|Update File): /.test(l)) break;
      raw.push(l);
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, startLineNo, strict));
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      consumed.add(m.from);
      consumed.add(m.to);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
