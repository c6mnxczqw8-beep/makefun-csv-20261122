// Fast drop-in replacement for csv-reader 1.0.0: returns exactly the same
// {columns, rows, errors} for every input, but parses with native indexOf
// scans and whole-field slices instead of character-by-character concatenation.
//
// Semantics reproduced from the reference (see README.md):
//  - U+FEFF at the very start is dropped; records end at LF or CRLF; a line
//    with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with '"' runs to the next non-doubled quote; "" is one
//    quote; CRLF / lone CR inside quotes read as LF; text after the closing
//    quote up to the next comma/line break is appended as-is (quote_junk
//    when anything was appended); a quote that never closes is a literal
//    character and the rest is re-read as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is literal; fields are never trimmed.
//  - columns is the first record when header is true, else null; rows are
//    padded (short_row, with fields) or cut (long_row, with extra) to the
//    first record's width. Errors are {code, line, row} in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CR_RE = /\r\n|\r|\n/g;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters starting at pos onto `value`, up to the next
  // comma or line break. Returns {value, ended, added}; `added` counts only
  // the characters this call kept (dropped stray CRs do not count).
  function readUnquoted(value) {
    let added = 0;
    while (true) {
      const start = pos;
      const ci = text.indexOf(',', start);
      const ni = text.indexOf('\n', start);
      let end;
      let ended;
      if (ci === -1 && ni === -1) {
        end = len;
        ended = END;
      } else if (ni === -1 || (ci !== -1 && ci < ni)) {
        end = ci;
        ended = COMMA;
      } else {
        end = ni;
        ended = LINE_BREAK;
      }
      let segEnd = end;
      // A CR immediately before the LF is the CRLF terminator, not content.
      if (ended === LINE_BREAK && end > start && text.charCodeAt(end - 1) === 13) {
        segEnd = end - 1;
      }
      const seg = text.slice(start, segEnd);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        value += seg;
        added += seg.length;
        pos = ended === END ? end : end + 1;
        if (ended === LINE_BREAK) line += 1;
        return { value, ended, added };
      }
      // A CR inside the segment is never followed by LF (the first LF is the
      // delimiter found above, and a CR right before it was cut as CRLF), so
      // it is a stray CR: keep what precedes it, record it, drop it, go on.
      value += seg.slice(0, ri);
      added += ri;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = start + ri + 1;
    }
  }

  // Converts a quoted segment containing line breaks: every CRLF or lone CR
  // becomes LF, and `line` advances once per break (LF, CRLF or lone CR).
  function convertBreaks(seg) {
    let count = 0;
    const out = seg.replace(CR_RE, () => {
      count += 1;
      return '\n';
    });
    line += count;
    return out;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let value = null;
    while (true) {
      const q = text.indexOf('"', segStart);
      if (q === -1) {
        // The quote never closes: literal character, re-read as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      let piece = text.slice(segStart, q);
      if (piece.indexOf('\r') !== -1 || piece.indexOf('\n') !== -1) {
        piece = convertBreaks(piece);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote, the field goes on.
        if (parts === null) parts = [piece, '"'];
        else parts.push(piece, '"');
        segStart = q + 2;
        continue;
      }
      // Closing quote.
      pos = q + 1;
      if (parts === null) value = piece;
      else {
        parts.push(piece);
        value = parts.join('');
      }
      break;
    }
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // Junk after the closing quote: appended as it stands (an unquoted read,
    // so a lone CR here is a stray_cr met before the quote_junk error).
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields = null;
    let quoted = false;

    fields = [];
    let field;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
