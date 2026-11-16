// main.ts — driver for the markdown-render-speed-02 entry.
//
// The harness executes `node /bot/main.ts` (Node 22, native type stripping,
// erasable syntax only). The contract:
//   * read every case from <input>/cases.json — a JSON array of
//     { id, markdown } objects;
//   * render each case on its own with parse() from ./parse.js;
//   * write <output>/html.json — a JSON array holding one HTML string per
//     case, in exactly the order the cases appear in the input.
// Inside the grading container <input> is /input and <output> is /output;
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override those two directories
// when the entry runs outside a container (local dev and grading alike).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

function inputDir(): string {
  return process.env.MAKEFUN_INPUT_DIR ?? '/input';
}

function outputDir(): string {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

/** Load and parse the case list the harness placed in the input directory. */
function loadCases(dir: string): Case[] {
  // Read the bytes once and decode in one pass; cases.json is a few MB and
  // JSON.parse on the decoded string is the fastest path available in the
  // sandbox (no streaming JSON parser in Node's built-ins).
  const raw = readFileSync(join(dir, 'cases.json')).toString('utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cases.json: not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(data)) {
    throw new Error('cases.json: expected a JSON array of cases');
  }
  return data as Case[];
}

/** Render every case independently, preserving the input order. */
function renderAll(cases: Case[]): string[] {
  // Preallocate: the output holds exactly one string per case, so the array
  // never has to grow. A render failure names the case that caused it —
  // with 720 cases an anonymous stack is needlessly hard to act on.
  const html: string[] = new Array<string>(cases.length);
  for (let k = 0; k < cases.length; k++) {
    try {
      html[k] = parse(cases[k].markdown);
    } catch (err) {
      throw new Error(`render failed on case ${k} (id ${cases[k].id}): ${(err as Error).message}`);
    }
  }
  return html;
}

function main(): void {
  const cases = loadCases(inputDir());
  const html = renderAll(cases);
  writeFileSync(join(outputDir(), 'html.json'), JSON.stringify(html));
}

main();
