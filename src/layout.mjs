// Pure helpers for the split (master-detail) layout and the Discussions title filter. No I/O.

export const SPLIT_MIN = 100;  // terminal width from which list and conversation sit side by side
export const MIN_LIST = 20;    // narrowest list column
export const MIN_CHAT = 40;    // narrowest conversation column
export const isWide = (w) => w >= SPLIT_MIN;

// Widest list column that still leaves MIN_CHAT columns and the 1-column divider for the conversation.
export const maxList = (w) => Math.max(MIN_LIST, w - MIN_CHAT - 1);
export const clampSplit = (n, w) => Math.max(MIN_LIST, Math.min(maxList(w), Math.round(Number(n))));
// Saved width (config `split`) if it is a number, else about 30 % of the screen between 24 and 40 columns.
export function splitWidth(w, pref) {
  if (Number.isFinite(Number(pref)) && pref !== null && pref !== "" && pref !== false) return clampSplit(pref, w);
  return clampSplit(Math.max(24, Math.min(40, Math.round(w * 0.3))), w);
}
// The divider sits in column list+1 (1-based); a press within one column of it grabs it.
export const onDivider = (x, list) => x >= list && x <= list + 2;
// Dragging the divider to column x puts the divider under the pointer.
export const dragTo = (x, w) => clampSplit(x - 1, w);

// Case, Turkish dotted/dotless i and diacritics folded away, so "istanbul", "İSTANBUL" and "ıstanbul" all match
// and "toplanti" finds "Toplantı".
export const fold = (s) => String(s ?? "")
  .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
  .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Discussions whose title contains every word of the query (any order). An empty query keeps everything.
export function filterTopics(topics, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return topics;
  return topics.filter((t) => { const title = fold(t.title); return words.every((w) => title.includes(w)); });
}
