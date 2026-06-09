// APRS symbol classification. APRS encodes an icon as a table char ("/" primary,
// "\" alternate, or an overlay) plus a code char. We don't render the full ~190
// symbol set; instead we fold the common codes into a handful of marker kinds
// and give each a colour and a human label.

export type AprsKind =
  | "car"
  | "truck"
  | "bike"
  | "person"
  | "home"
  | "wx"
  | "balloon"
  | "boat"
  | "aircraft"
  | "digi"
  | "phone"
  | "dot";

/** Map an APRS symbol (table+code) to a marker kind. */
export function aprsKind(symbol?: string): AprsKind {
  if (!symbol || symbol.length < 2) return "dot";
  switch (symbol[1]) {
    case ">":
      return "car";
    case "j": // jeep
    case "v": // van
      return "car";
    case "k": // truck
    case "u": // semi / 18-wheeler
      return "truck";
    case "<": // motorcycle
    case "b": // bicycle
      return "bike";
    case "[": // jogger / human
      return "person";
    case "-": // house (QTH)
      return "home";
    case "_": // weather station
      return "wx";
    case "O": // balloon
    case "S": // satellite/spacecraft
      return "balloon";
    case "s": // ship / power boat
    case "Y": // yacht (sail)
      return "boat";
    case "^": // large aircraft
    case "'": // small aircraft
    case "g": // glider
      return "aircraft";
    case "#": // digipeater
    case "&": // HF gateway / I-gate
      return "digi";
    case "$": // phone
      return "phone";
    default:
      return "dot";
  }
}

export function aprsColor(kind: AprsKind): string {
  switch (kind) {
    case "car":
    case "truck":
    case "bike":
      return "#38bdf8"; // moving ground stations
    case "aircraft":
      return "#f472b6";
    case "boat":
      return "#2dd4bf";
    case "balloon":
      return "#c084fc";
    case "wx":
      return "#facc15";
    case "home":
      return "#94a3b8";
    case "digi":
      return "#fb923c";
    case "person":
      return "#a3e635";
    default:
      return "#cbd5e1";
  }
}

export function aprsKindLabel(kind: AprsKind): string {
  switch (kind) {
    case "car":
      return "Vehicle";
    case "truck":
      return "Truck";
    case "bike":
      return "Cycle";
    case "person":
      return "Person";
    case "home":
      return "Home station";
    case "wx":
      return "Weather";
    case "balloon":
      return "Balloon";
    case "boat":
      return "Boat";
    case "aircraft":
      return "Aircraft";
    case "digi":
      return "Digipeater";
    case "phone":
      return "Phone";
    default:
      return "Station";
  }
}

/** Whether a marker should rotate to its course (moving vehicles/craft). */
export function aprsRotates(kind: AprsKind): boolean {
  return (
    kind === "car" ||
    kind === "truck" ||
    kind === "bike" ||
    kind === "aircraft" ||
    kind === "boat"
  );
}
