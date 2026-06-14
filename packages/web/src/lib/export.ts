// Client-side data export: turn the decoder logs (aircraft, vessels, stations,
// ISM events, transcripts) into CSV or JSON and hand the user a download. No
// server round-trip — everything is already in the browser.

/** One CSV column: a header and how to pull its value from a row. */
export interface Column<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/** RFC 4180-ish CSV: CRLF rows, fields quoted only when they contain a quote,
 *  comma or newline; embedded quotes doubled. */
export function toCsv<T>(rows: readonly T[], columns: Column<T>[]): string {
  const esc = (v: string | number | boolean | null | undefined): string => {
    if (v == null) return "";
    const s = String(v);
    return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => esc(c.value(row))).join(","));
  }
  return lines.join("\r\n");
}

/** Trigger a browser download of an in-memory blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched so the download can start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download arbitrary text as a file with the given MIME type. */
export function downloadText(
  filename: string,
  mime: string,
  text: string,
): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Compact local-time stamp for filenames, e.g. "20260612_143005". */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** ISO-8601 string for an epoch-ms value, or "" when absent. */
export function isoTime(ms: number | null | undefined): string {
  return ms == null ? "" : new Date(ms).toISOString();
}
