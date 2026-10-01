// «Кто первым?» — копия backend/bagdar/meet.py для витрины без сервера.
// Источник правды — ядро. Совпадение проверяет `npm run check:meet` по fixture.json,
// который пишет showcase/tools/meet_fixture.py из настоящего модуля ядра.
// Файл без импортов: его запускает и Vite, и Node (сверка) напрямую.

export type PaxClass = "high_speed_passenger" | "fast_passenger" | "passenger";
export type FreightClass = "express_freight" | "freight" | "local_freight";
export type Cargo = "urgent" | "perishable" | "deadline" | "dangerous";
export type OptionId = "pax_first" | "freight_first";

export interface PaxIn {
  cls: PaxClass;
  passengers: number;
  delay_min: number;
  slack_min: number;
  dwell_min: number;
  transfer: boolean;
  trip_left_h: number;
}

export interface FreightIn {
  cls: FreightClass;
  mass_t: number;
  cargo: Cargo[];
  delay_min: number;
  slack_min: number;
  uphill: boolean;
  crew_left_h: number;
  trip_left_h: number;
}

export interface MeetParams {
  section_km: number;
  speed_limit_kmh: number;
  gap_min: number;
  pax: PaxIn;
  freight: FreightIn;
}

export interface MeetParamsPatch {
  section_km?: number;
  speed_limit_kmh?: number;
  gap_min?: number;
  pax?: Partial<PaxIn>;
  freight?: Partial<FreightIn>;
}

export interface Seg { t0: number; t1: number; x0: number; x1: number; v0: number; v1: number }

export interface Side {
  stopped: boolean;
  planned_stop: boolean;
  arr: number;
  dep: number;
  wait_s: number;
  extra_s: number;
  late_s: number;
  arr_far: number;
}

export interface CostLines {
  delay_pax: number;
  delay_freight: number;
  stop_pax: number;
  stop_freight: number;
  idle_pax: number;
  idle_freight: number;
  pte: number;
}

export interface MeetOption {
  id: OptionId;
  yield: "pax" | "freight";
  motion: { pax: Seg[]; freight: Seg[] };
  pax: Side;
  freight: Side;
  kwh: { pax: number; freight: number };
  cost: CostLines;
  econ: number;
  total: number;
  pte_excess_min: number;
  pax_person_min: number;
  freight_ton_h: number;
  end_t: number;
}

export interface TrainInfo {
  cls: string;
  label: string;
  length_m: number;
  mass_t: number;
  v_kmh: number;
  passengers?: number | null;
  pte_rank: number;
  weight: number;
  factors: [string, number][];
  base_weight: number;
  tolerance_min: number;
  stop_kwh: number;
  brake_s: number;
  accel_s: number;
}

export interface MeetResult {
  params: MeetParams;
  geometry: { section_m: number; view_from_m: number; view_to_m: number; loop_m: number; tau_cross_s: number };
  trains: { pax: TrainInfo; freight: TrainInfo };
  options: MeetOption[];
  winner: OptionId;
  econ_winner: OptionId;
  saving: number;
  econ_saving: number;
  constants: { c_stop: number; c_idle: number; pte_penalty_per_min: number; uphill_factor: number; min_stop_s: number; pte_strict: boolean };
}

// --- те же константы, что в ядре (config/default.yaml, core/classes.py, planner/economics.py)
interface Cls { label: string; pte_rank: number; vmax_kmh: number; accel: number; decel: number; weight: number; tolerance_min: number }
export const CLASSES: Record<PaxClass | FreightClass, Cls> = {
  high_speed_passenger: { label: "Скоростной пассажирский", pte_rank: 1, vmax_kmh: 160, accel: 0.45, decel: 0.6, weight: 100, tolerance_min: 2 },
  fast_passenger: { label: "Скорый пассажирский", pte_rank: 2, vmax_kmh: 120, accel: 0.35, decel: 0.5, weight: 70, tolerance_min: 3 },
  passenger: { label: "Пассажирский", pte_rank: 3, vmax_kmh: 100, accel: 0.35, decel: 0.5, weight: 50, tolerance_min: 5 },
  express_freight: { label: "Ускоренный грузовой", pte_rank: 4, vmax_kmh: 90, accel: 0.15, decel: 0.35, weight: 30, tolerance_min: 15 },
  freight: { label: "Грузовой", pte_rank: 5, vmax_kmh: 80, accel: 0.1, decel: 0.3, weight: 10, tolerance_min: 30 },
  local_freight: { label: "Сборный грузовой", pte_rank: 5, vmax_kmh: 70, accel: 0.12, decel: 0.3, weight: 5, tolerance_min: 60 },
};
export const CONST = {
  c_stop: 0.5, c_idle: 2, tau_cross_s: 90, min_stop_s: 30,
  pte_penalty_per_min: 5000, uphill_factor: 4,
};
const T0_S = 180;
const VIEW_M = 4500;
const EXIT_M = 6000;

export const DEFAULTS: MeetParams = {
  section_km: 12, speed_limit_kmh: 100, gap_min: 0,
  pax: { cls: "fast_passenger", passengers: 600, delay_min: 0, slack_min: 3, dwell_min: 0, transfer: false, trip_left_h: 3 },
  freight: { cls: "freight", mass_t: 5000, cargo: [], delay_min: 0, slack_min: 20, uphill: false, crew_left_h: 6, trip_left_h: 4 },
};

export function withDefaults(p: MeetParamsPatch = {}): MeetParams {
  return {
    section_km: p.section_km ?? DEFAULTS.section_km,
    speed_limit_kmh: p.speed_limit_kmh ?? DEFAULTS.speed_limit_kmh,
    gap_min: p.gap_min ?? DEFAULTS.gap_min,
    pax: { ...DEFAULTS.pax, ...(p.pax ?? {}) },
    freight: { ...DEFAULTS.freight, ...(p.freight ?? {}), cargo: [...(p.freight?.cargo ?? DEFAULTS.freight.cargo)] },
  };
}

/** round() Питона: к ближайшему, половина — к чётному (для целых счётчиков). */
function pyRound(x: number, nd = 0): number {
  const m = 10 ** nd;
  const y = x * m;
  const f = Math.floor(y);
  const diff = y - f;
  let r: number;
  if (Math.abs(diff - 0.5) < 1e-9) r = f % 2 === 0 ? f : f + 1;
  else r = Math.round(y);
  return r / m;
}

export function freightLengthM(mass: number): number {
  return Math.max(10, pyRound(mass / 70)) * 14 + 34;
}

export function paxLengthM(passengers: number): number {
  return Math.max(4, Math.min(20, Math.ceil(passengers / 54))) * 25 + 20;
}

function stopKwh(mass_t: number, v: number): number {
  return (mass_t * 1000 * v * v) / 2 / 3.6e6;
}

/** planner/economics.py: train_weight — вес минуты задержки и множители. */
function trainWeight(cls: PaxClass | FreightClass, passengers: number, cargo: string[], transfer: boolean,
  tripLeftH: number, crewLeftH: number, latenessS: number): [number, [string, number][]] {
  const c = CLASSES[cls];
  let w = c.weight;
  const f: [string, number][] = [];
  if (passengers > 0 && c.pte_rank <= 3) f.push([`пассажиров ${passengers}`, Math.max(0.5, passengers / 500)]);
  if (transfer && latenessS >= 60) f.push(["пересадка под угрозой", 1.5]);
  if (cargo.includes("perishable") || cargo.includes("urgent")) f.push(["срочный или скоропортящийся груз", 1.5]);
  if (cargo.includes("deadline")) f.push(["истекает срок доставки", 2.0]);
  if (cargo.includes("dangerous")) f.push(["опасный груз", 1.3]);
  const remaining = Math.max(0, tripLeftH * 3600) + latenessS;
  if (crewLeftH * 3600 < remaining + 3600) f.push([`у бригады осталось ${Math.max(0, crewLeftH).toFixed(1)} ч`, 2.0]);
  const tol = c.tolerance_min * 60;
  if (latenessS > tol) {
    const steps = Math.floor((latenessS - tol) / 600) + 1;
    f.push([`уже опаздывает на ${pyRound(latenessS / 60)} мин`, 1.2 ** steps]);
  }
  for (const [, m] of f) w *= m;
  return [w, f];
}

class Motion {
  x0: number; dir: number; v: number; L: number;
  tb: number; db: number; ta: number; da: number;
  constructor(x0: number, dir: number, v: number, a: number, d: number, L: number) {
    this.x0 = x0; this.dir = dir; this.v = v; this.L = L;
    this.tb = v / d; this.db = (v * v) / (2 * d);
    this.ta = v / a; this.da = (v * v) / (2 * a);
  }

  pass(tReach: number): [Seg[], number] {
    const pre = this.v * tReach;
    const end = this.L + EXIT_M;
    return [[this.seg(0, tReach + end / this.v, -pre, end, this.v, this.v)], tReach + this.L / this.v];
  }

  stop(tArr: number, tDep: number): [Seg[], number] {
    const pre = this.db + this.v * (tArr - this.tb);
    const tEnd = tDep + this.ta + (this.L + EXIT_M - this.da) / this.v;
    const segs = [
      this.seg(0, tArr - this.tb, -pre, -this.db, this.v, this.v),
      this.seg(tArr - this.tb, tArr, -this.db, 0, this.v, 0),
      this.seg(tArr, tDep, 0, 0, 0, 0),
      this.seg(tDep, tDep + this.ta, 0, this.da, 0, this.v),
      this.seg(tDep + this.ta, tEnd, this.da, this.L + EXIT_M, this.v, this.v),
    ];
    return [segs.filter((s) => s.t1 > s.t0), tDep + this.ta + (this.L - this.da) / this.v];
  }

  private seg(t0: number, t1: number, s0: number, s1: number, v0: number, v1: number): Seg {
    return { t0: pyRound(t0, 2), t1: pyRound(t1, 2), x0: pyRound(this.x0 + this.dir * s0, 1),
      x1: pyRound(this.x0 + this.dir * s1, 1), v0: pyRound(v0, 3), v1: pyRound(v1, 3) };
  }
}

interface SideRaw { segs: Seg[]; arr2: number; stopped: boolean; planned: boolean; arr: number; dep: number; wait_s: number }

function side(m: Motion, tReach: number, dwell: number, tFree: number | null, minStop: number): SideRaw {
  if (dwell > 0) {
    const depPlan = tReach + dwell;
    const dep = Math.max(depPlan, tFree ?? 0);
    const [segs, arr2] = m.stop(tReach, dep);
    return { segs, arr2, stopped: true, planned: true, arr: tReach, dep, wait_s: dep - depPlan };
  }
  if (tFree === null || tFree <= tReach) {
    const [segs, arr2] = m.pass(tReach);
    return { segs, arr2, stopped: false, planned: false, arr: tReach, dep: tReach, wait_s: 0 };
  }
  const arr = tReach + m.tb / 2;
  const dep = Math.max(arr + minStop, tFree);
  const [segs, arr2] = m.stop(arr, dep);
  return { segs, arr2, stopped: true, planned: false, arr, dep, wait_s: dep - arr };
}

function addedLate(delayMin: number, extra: number, slackMin: number): number {
  const d = delayMin * 60;
  const s = slackMin * 60;
  return Math.max(0, d + extra - s) - Math.max(0, d - s);
}

function sideOut(s: SideRaw, extra: number, late: number): Side {
  return { stopped: s.stopped, planned_stop: s.planned, arr: pyRound(s.arr, 1), dep: pyRound(s.dep, 1),
    wait_s: pyRound(s.wait_s, 1), extra_s: pyRound(extra, 1), late_s: pyRound(late, 1), arr_far: pyRound(s.arr2, 1) };
}

export function compare(params: MeetParamsPatch = {}, pteStrict = true): MeetResult {
  const p = withDefaults(params);
  const L = p.section_km * 1000;
  const cp = CLASSES[p.pax.cls];
  const cf = CLASSES[p.freight.cls];
  const vp = Math.min(cp.vmax_kmh, p.speed_limit_kmh) / 3.6;
  const vf = Math.min(cf.vmax_kmh, p.speed_limit_kmh) / 3.6;
  const paxLen = paxLengthM(p.pax.passengers);
  const frLen = freightLengthM(p.freight.mass_t);
  const paxMass = pyRound((paxLen / 25) * 58 + 120);
  const tau = CONST.tau_cross_s;
  const minStop = CONST.min_stop_s;
  const gap = p.gap_min * 60;
  const tPa = T0_S + Math.max(0, gap);
  const tFb = T0_S + Math.max(0, -gap);
  const dwell = p.pax.dwell_min * 60;
  const cargo = p.freight.cargo.filter((c) => ["urgent", "perishable", "deadline", "dangerous"].includes(c));

  const [wP, fP] = trainWeight(p.pax.cls, p.pax.passengers, [], p.pax.transfer, p.pax.trip_left_h, 8, p.pax.delay_min * 60);
  const [wF, fF] = trainWeight(p.freight.cls, 0, cargo, false, p.freight.trip_left_h, p.freight.crew_left_h, p.freight.delay_min * 60);
  const tolP = cp.tolerance_min * 60;

  const mp = new Motion(0, 1, vp, cp.accel, cp.decel, L);
  const mf = new Motion(L, -1, vf, cf.accel, cf.decel, L);
  const freeP = side(mp, tPa, dwell, null, minStop);
  const freeF = side(mf, tFb, 0, null, minStop);

  const options: MeetOption[] = (["pax_first", "freight_first"] as OptionId[]).map((oid) => {
    let sp: SideRaw;
    let sf: SideRaw;
    if (oid === "pax_first") {
      sp = freeP;
      sf = side(mf, tFb, 0, sp.arr2 + tau, minStop);
    } else {
      sf = freeF;
      sp = side(mp, tPa, dwell, sf.arr2 + tau, minStop);
    }
    const extraP = sp.arr2 - freeP.arr2;
    const extraF = sf.arr2 - freeF.arr2;
    const lateP = addedLate(p.pax.delay_min, extraP, p.pax.slack_min);
    const lateF = addedLate(p.freight.delay_min, extraF, p.freight.slack_min);
    const cost: CostLines = { delay_pax: (wP * lateP) / 60, delay_freight: (wF * lateF) / 60,
      stop_pax: 0, stop_freight: 0, idle_pax: 0, idle_freight: 0, pte: 0 };
    const kwh = { pax: 0, freight: 0 };
    if (sp.stopped && !sp.planned) {
      kwh.pax = stopKwh(paxMass, vp);
      cost.stop_pax = CONST.c_stop * kwh.pax;
      cost.idle_pax = (Math.max(0, sp.wait_s - minStop) / 60) * CONST.c_idle;
    }
    if (sf.stopped) {
      kwh.freight = stopKwh(p.freight.mass_t, vf);
      cost.stop_freight = CONST.c_stop * kwh.freight * (p.freight.uphill ? CONST.uphill_factor : 1);
      cost.idle_freight = (Math.max(0, sf.wait_s - minStop) / 60) * CONST.c_idle;
    }
    let pteExcess = 0;
    if (oid === "freight_first" && pteStrict && cp.pte_rank < cf.pte_rank) {
      const exc = extraP - tolP;
      if (exc > 1) {
        pteExcess = exc;
        cost.pte = (CONST.pte_penalty_per_min * exc) / 60;
      }
    }
    const econ = cost.delay_pax + cost.delay_freight + cost.stop_pax + cost.stop_freight + cost.idle_pax + cost.idle_freight;
    const r1 = (x: number) => pyRound(x, 1);
    return {
      id: oid,
      yield: oid === "pax_first" ? "freight" : "pax",
      motion: { pax: sp.segs, freight: sf.segs },
      pax: sideOut(sp, extraP, lateP),
      freight: sideOut(sf, extraF, lateF),
      kwh: { pax: r1(kwh.pax), freight: r1(kwh.freight) },
      cost: { delay_pax: r1(cost.delay_pax), delay_freight: r1(cost.delay_freight), stop_pax: r1(cost.stop_pax),
        stop_freight: r1(cost.stop_freight), idle_pax: r1(cost.idle_pax), idle_freight: r1(cost.idle_freight), pte: r1(cost.pte) },
      econ: r1(econ),
      total: r1(econ + cost.pte),
      pte_excess_min: pyRound(pteExcess / 60, 2),
      pax_person_min: pyRound((p.pax.passengers * extraP) / 60),
      freight_ton_h: pyRound((p.freight.mass_t * extraF) / 3600),
      end_t: r1(Math.max(sp.segs[sp.segs.length - 1].t1, sf.segs[sf.segs.length - 1].t1)),
    } as MeetOption;
  });
  const [a, b] = options;
  const winner = a.total <= b.total ? a : b;
  const loser = winner === a ? b : a;
  const econWinner = a.econ <= b.econ ? a : b;
  const fr = (n: string, m: number): [string, number] => [n, pyRound(m, 3)];
  return {
    params: p,
    geometry: { section_m: L, view_from_m: -VIEW_M, view_to_m: L + VIEW_M, loop_m: Math.max(1400, Math.max(frLen, paxLen) + 300), tau_cross_s: tau },
    trains: {
      pax: { cls: p.pax.cls, label: cp.label, length_m: pyRound(paxLen), mass_t: paxMass, v_kmh: pyRound(vp * 3.6),
        passengers: p.pax.passengers, pte_rank: cp.pte_rank, weight: pyRound(wP, 2), factors: fP.map(([n, m]) => fr(n, m)),
        base_weight: cp.weight, tolerance_min: tolP / 60, stop_kwh: pyRound(stopKwh(paxMass, vp), 1),
        brake_s: pyRound(mp.tb), accel_s: pyRound(mp.ta) },
      freight: { cls: p.freight.cls, label: cf.label, length_m: pyRound(frLen), mass_t: pyRound(p.freight.mass_t),
        v_kmh: pyRound(vf * 3.6), pte_rank: cf.pte_rank, weight: pyRound(wF, 2), factors: fF.map(([n, m]) => fr(n, m)),
        base_weight: cf.weight, tolerance_min: cf.tolerance_min, stop_kwh: pyRound(stopKwh(p.freight.mass_t, vf), 1),
        brake_s: pyRound(mf.tb), accel_s: pyRound(mf.ta) },
    },
    options,
    winner: winner.id,
    econ_winner: econWinner.id,
    saving: pyRound(loser.total - winner.total, 1),
    econ_saving: pyRound(Math.abs(a.econ - b.econ), 1),
    constants: { c_stop: CONST.c_stop, c_idle: CONST.c_idle, pte_penalty_per_min: CONST.pte_penalty_per_min,
      uphill_factor: CONST.uphill_factor, min_stop_s: minStop, pte_strict: pteStrict },
  };
}

/** Положение головы поезда в момент t по отрезкам движения (то же, что в тесте ядра). */
export function posAt(segs: Seg[], t: number): { x: number; v: number } {
  if (t <= segs[0].t0) return { x: segs[0].x0, v: segs[0].v0 };
  for (const s of segs) {
    if (t <= s.t1) {
      const dt = s.t1 - s.t0;
      if (dt <= 0) return { x: s.x0, v: s.v0 };
      const tau = t - s.t0;
      const a = (s.v1 - s.v0) / dt;
      const sign = s.x1 >= s.x0 ? 1 : -1;
      return { x: s.x0 + sign * (s.v0 * tau + (a * tau * tau) / 2), v: s.v0 + a * tau };
    }
  }
  const last = segs[segs.length - 1];
  return { x: last.x1, v: last.v1 };
}
