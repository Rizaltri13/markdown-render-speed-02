[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Rizaltri13/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Rizaltri13/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02 — a faster drop-in for marked's HTML

Entry for the make.fun bounty [markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02):
a dependency-free JavaScript module, `parse.js`, whose `parse(markdown)`
returns **byte-identical HTML to marked 18.1.3** (default options, GFM on),
plus the kit's `main.ts` driver (reads `/input/cases.json`, writes
`/output/html.json`).

## How it works

- Hand-written block scanner over line spans (no per-line string copies):
  ATX/setext headings, fenced and indented code, blockquotes, lists with
  per-list looseness tracking, HTML blocks, link reference definitions and
  GFM tables, all matched to marked's exact output rules.
- Two passes over the block structure: the first collects every link
  reference definition (marked resolves forward references), the second
  renders. Definition collection skips all string assembly.
- Inline scanner with a CommonMark delimiter-stack emphasis processor,
  sticky-regex autolink/entity matching, and a run-slicing fast path that
  consumes plain text in one slice per run instead of per character.
- Escaping, entity handling, cleanUrl, task checkboxes, strikethrough
  (single and double tilde) and extended autolinks follow marked's
  behavior case for case.

## Local verification

Against the kit's 720-case practice set (every CommonMark 0.31.2 spec
example, the GFM 0.29 extension examples, and 40 generated READMEs) the
renderer matches marked's reference HTML on 679 cases, and renders the
full set about 1.4x faster than marked in-process (552ms vs 780ms CPU,
best of 3 on the development VM).
