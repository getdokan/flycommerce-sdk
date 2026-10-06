// OSC (links, titles) and CSI (colours, cursor) sequences, removed whole so nothing of them shows.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Other C0 and C1 controls but newline, DEL, and bidi overrides that reorder what a terminal shows.
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text a terminal shows as it is: no escape sequences, controls or bidi overrides. */
export function printable(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(CONTROLS, '');
}
