export type AircraftClassKey =
  | "light"
  | "glider"
  | "turboprop"
  | "airliner"
  | "widebody"
  | "quadjet"
  | "helicopter"
  | "fastjet"
  | "bizjet"
  | "uav";

const HELI = new Set(["EC20","EC25","EC30","EC35","EC45","EC55","AS50","AS55","AS65","AS32","A109","A119","A139","A169","A189","B06","B06T","B407","B412","B429","B505","S76","S92","H60","H500","R22","R44","R66","NH90","UH1","H47","H64"]);
const QUAD = new Set(["B741","B742","B743","B744","B748","A388","A342","A343","A345","A346","A124","C5M","IL96","B52"]);
const WIDE = new Set(["A306","A310","A332","A333","A338","A339","A359","A35K","B762","B763","B764","B772","B77L","B773","B77W","B778","B779","B788","B789","B78X","MD11","DC10","L101","C17","K35R"]);
const TPROP = new Set(["DH8A","DH8B","DH8C","DH8D","AT43","AT44","AT45","AT46","AT72","AT73","AT75","AT76","SF34","SB20","C208","PC12","B190","BE20","B350","C130","A400"]);
const GLIDER = new Set(["DISC","DUOD","VENT","NIMB","AS33","ASW","ASG","ASK","GLID","DG40","DG80","LS4","LS6","LS8"]);
const LIGHT = new Set(["C150","C152","C162","C172","C182","C206","C210","SR20","SR22","PA18","PA28","PA32","PA34","PA44","DA20","DA40","DA42","DA62","BE33","BE35","BE36","BE58","RV7","RV8","RV10"]);
const BIZJET = new Set(["C500","C501","C510","C525","C25A","C25B","C25C","C550","C560","C56X","C650","C680","C68A","C700","C750","CL30","CL35","CL60","GLF2","GLF3","GLF4","GLF5","GLF6","G150","G280","GLEX","LJ31","LJ35","LJ40","LJ45","LJ55","LJ60","LJ70","LJ75","FA10","FA20","FA50","FA7X","FA8X","F900","H25A","H25B","H25C","HDJT","E50P","E55P","PC24","BE40","SF50"]);
const UAV = new Set(["Q1","Q4","Q9","MQ1","MQ4","MQ9","RQ4","TB2","SHDW","HERN"]);
const FASTJET = new Set(["F16","F15","F18","FA18","F14","F22","F35","F4","F5","A10","AV8B","TYPH","EUFI","RFAL","GRIP","JAS39","MIR2","SU27","SU30","SU33","SU34","SU35","SU57","MG29","MIG29","MG31","J20","T38","HAWK","L39","M346","T7A"]);

const OPENSKY_CATEGORY: Record<number, AircraftClassKey> = {
  2: "light",
  3: "airliner",
  4: "airliner",
  5: "airliner",
  6: "widebody",
  7: "fastjet",
  8: "helicopter",
  9: "glider",
};

const EMITTER_CATEGORY: Record<string, AircraftClassKey> = {
  A1: "light",
  A2: "light",
  A3: "airliner",
  A4: "airliner",
  A5: "widebody",
  A6: "fastjet",
  A7: "helicopter",
  B1: "glider",
};

export function classifyAircraft(input: { typeCode?: string | null; category?: string | number | null } = {}): AircraftClassKey {
  const code = String(input.typeCode ?? "").trim().toUpperCase();
  if (code) {
    if (FASTJET.has(code)) return "fastjet";
    if (UAV.has(code)) return "uav";
    if (HELI.has(code)) return "helicopter";
    if (QUAD.has(code)) return "quadjet";
    if (WIDE.has(code)) return "widebody";
    if (TPROP.has(code)) return "turboprop";
    if (GLIDER.has(code)) return "glider";
    if (BIZJET.has(code)) return "bizjet";
    if (LIGHT.has(code)) return "light";
    if (/^(H|HELI)|H60|UH60|CH47|AH64|EC\d|AS\d|B06|R22|R44|S76/.test(code)) return "helicopter";
    if (/F16|F18|F35|F22|EUFI|T38|HAWK|L39|M346|FA50/.test(code)) return "fastjet";
    if (/MQ9|RQ4|TB2/.test(code)) return "uav";
    return "airliner";
  }

  const numeric = typeof input.category === "number"
    ? input.category
    : /^\d+$/.test(String(input.category ?? "")) ? Number(input.category) : NaN;
  if (Number.isFinite(numeric) && OPENSKY_CATEGORY[numeric]) return OPENSKY_CATEGORY[numeric];

  const emitter = String(input.category ?? "").trim().toUpperCase();
  return EMITTER_CATEGORY[emitter] ?? "airliner";
}

export const CLASS_SCALE_2D: Record<AircraftClassKey, number> = {
  light: 0.62,
  glider: 0.58,
  turboprop: 0.86,
  airliner: 1,
  widebody: 1.3,
  quadjet: 1.45,
  helicopter: 0.82,
  fastjet: 0.8,
  bizjet: 0.72,
  uav: 0.75,
};
