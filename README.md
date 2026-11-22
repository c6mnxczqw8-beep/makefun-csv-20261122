# Kinako Fast CSV Reader — make.fun "Read broken CSV files faster"

A drop-in replacement for csv-reader 1.0.0 that returns byte-identical
answers (`{columns, rows, errors}`) for every input, much faster.

## Layout

- `main.ts` — the harness driver (same shape as the house baseline's):
  reads `/input/cases.json`, answers each case with `run()` from
  `solve.js`, writes `/output/answers.json`. Runs with V8's incremental
  marking off, as the house driver does.
- `solve.js` — dependency-free ES module exporting `run(input)`.

## Approach

The reference reader walks the text one character at a time and builds each
field by single-character concatenation. This entry keeps the exact same
semantics but never touches a character it does not have to:

- **Unquoted fields** are located with native `indexOf` scans for the next
  comma and LF, then taken as one `slice`. A CR just before the LF is the
  CRLF terminator; any other CR inside the slice is a stray CR (dropped,
  `stray_cr` recorded) and only then does the field fall back to a
  segment-by-segment loop.
- **Quoted fields** jump from quote to quote with `indexOf('"')`. Segments
  without line breaks are sliced verbatim; doubled quotes are reassembled
  from pieces only when present; segments containing CR/LF get one regex
  pass that rewrites CRLF and lone CR to LF while counting lines. A quote
  that never closes re-reads the rest as unquoted from the opening quote,
  exactly like the reference (`unterminated_quote`). Junk after a closing
  quote goes through the unquoted reader, so `stray_cr` errors inside junk
  are recorded before `quote_junk`, in the reference's order.
- Record assembly (blank-line skipping, header handling, `short_row`
  padding with `fields`, `long_row` cutting with `extra`, error
  `{code, line, row}` values) mirrors the reference line for line.

## Verification

- Practice set: 6/6 cases identical to the reference, answers file
  byte-identical to the house baseline's.
- ~3,400 randomized fuzz inputs (small adversarial token soup and
  generator-style files with every broken-row kind) all match the
  reference oracle exactly.
- Local timing on the practice set: CSV parsing ≈ 95 ms vs the reference's
  ≈ 700–790 ms of CPU (≈ 7×); the whole program ≈ 0.70 s vs ≈ 1.65 s of
  user CPU (≈ 2.3×), the rest being JSON input/output the driver shares
  with the baseline.
