import {
  acrossLane,
  alongLane,
  findMainlines,
  mainlinePointNames,
  type LaneAxis,
} from '../../zones/domain/mainline';

import {
  computeEgressPoints,
  computeFeederPoints,
  hopsToExit,
  type PlantPath,
} from '../../zones/domain/zone-topology';
import {
  resolveLocationPoints,
  type PlantLocation,
} from '../../zones/domain/member-points';
import { behindChain } from './retreat-point';

export const MAX_COLUMN_LEAD = 3;
const CELLS_PER_WAITING_SPOT = 2;

export interface PlantPointPosition {
  x: number;
  y: number;
}

export interface PlantPoint {
  name: string;
  position: PlantPointPosition;
}

export interface ZoneSlot {
  readonly locationName: string;
  readonly pointName: string;
}

export interface ZoneLane {
  readonly axis: number;
  readonly slots: readonly ZoneSlot[];
  readonly axisPoints: readonly string[];
  readonly axisAlong: readonly number[];
}

export interface ZoneSlotLayout {
  readonly mainlinePoints: ReadonlySet<string>;
  readonly columns: readonly (readonly ZoneSlot[])[];
  readonly lanes: readonly ZoneLane[];
  readonly entryPoints: readonly string[];
  readonly memberPointNames: ReadonlySet<string>;
  readonly strandedLocationNames: readonly string[];
}

interface PositionedSlot extends ZoneSlot {
  readonly x: number;
  readonly y: number;
}

export function buildZoneSlotLayout(
  points: readonly PlantPoint[],
  paths: readonly PlantPath[],
  locations: readonly PlantLocation[],
  memberLocationNames: readonly string[],
  laneAxis: LaneAxis = 'y',
): ZoneSlotLayout {
  const pointByLocation = resolveLocationPoints(locations, memberLocationNames);
  const memberPointNames = new Set(pointByLocation.values());
  const positionByPoint = new Map(
    points.map((point) => [point.name, point.position]),
  );

  const egress = computeEgressPoints(paths, memberPointNames);
  const hops = hopsToExit(paths, memberPointNames, egress);

  const positioned: PositionedSlot[] = [];
  const stranded: string[] = [];
  for (const locationName of memberLocationNames) {
    const pointName = pointByLocation.get(locationName);
    const position = pointName ? positionByPoint.get(pointName) : undefined;
    if (!pointName || !position || !hops.has(pointName)) {
      stranded.push(locationName);
      continue;
    }
    positioned.push({ locationName, pointName, x: position.x, y: position.y });
  }

  const lanes = inFlowOrder(
    groupIntoLanes(positioned, laneAxis),
    paths,
    memberPointNames,
    positioned,
    laneAxis,
  );
  const mainlinePoints = mainlinePointNames(findMainlines(points, paths));
  return {
    mainlinePoints,
    columns: lanes.map((lane) => lane.map(bareSlot)),
    lanes: lanes.map((lane) => {
      const axis = axisOf(lane, points, paths, laneAxis, mainlinePoints);
      return {
        axis: acrossLane(laneAxis, lane[0]),
        slots: lane.map(bareSlot),
        axisPoints: axis.map((cell) => cell.pointName),
        axisAlong: axis.map((cell) => cell.along),
      };
    }),
    entryPoints: computeFeederPoints(paths, memberPointNames),
    memberPointNames,
    strandedLocationNames: stranded,
  };
}

interface AxisCell {
  readonly pointName: string;
  readonly along: number;
}

function axisOf(
  lane: readonly PositionedSlot[],
  points: readonly PlantPoint[],
  paths: readonly PlantPath[],
  laneAxis: LaneAxis,
  mainlinePoints: ReadonlySet<string>,
): AxisCell[] {
  const positionOf = new Map(
    points.map((point) => [point.name, point.position] as const),
  );
  const shallowest = lane[lane.length - 1];
  const behind = queueTail(
    behindChain({ points, paths }, shallowest.pointName, laneAxis),
    mainlinePoints,
    lane.length,
  );

  return [
    ...lane.map((slot) => ({
      pointName: slot.pointName,
      along: alongLane(laneAxis, slot),
    })),
    ...behind.reduce<AxisCell[]>((cells, pointName) => {
      const position = positionOf.get(pointName);
      if (position) {
        cells.push({ pointName, along: alongLane(laneAxis, position) });
      }
      return cells;
    }, []),
  ];
}

function queueTail(
  behind: readonly string[],
  mainlinePoints: ReadonlySet<string>,
  slotCount: number,
): string[] {
  const tail: string[] = [];
  for (const pointName of behind) {
    tail.push(pointName);
    if (mainlinePoints.has(pointName)) break;
    if (tail.length === slotCount * CELLS_PER_WAITING_SPOT) break;
  }
  return tail;
}

function bareSlot({ locationName, pointName }: PositionedSlot): ZoneSlot {
  return { locationName, pointName };
}

function groupIntoLanes(
  slots: readonly PositionedSlot[],
  laneAxis: LaneAxis,
): PositionedSlot[][] {
  const byAxis = new Map<number, PositionedSlot[]>();
  for (const slot of slots) {
    const across = acrossLane(laneAxis, slot);
    const lane = byAxis.get(across);
    if (lane) lane.push(slot);
    else byAxis.set(across, [slot]);
  }

  return [...byAxis.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, lane]) =>
      lane.sort((a, b) => alongLane(laneAxis, a) - alongLane(laneAxis, b)),
    );
}

function crossLaneDirection(
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
  slots: readonly PositionedSlot[],
  laneAxis: LaneAxis,
): number {
  const xOf = new Map(
    slots.map((slot) => [slot.pointName, acrossLane(laneAxis, slot)]),
  );
  for (const path of paths) {
    const src = path.srcPointName;
    const dest = path.destPointName;
    if (!src || !dest) continue;
    if (!memberPointNames.has(src) || !memberPointNames.has(dest)) continue;

    const from = xOf.get(src);
    const to = xOf.get(dest);
    if (from == null || to == null || from === to) continue;
    if (path.maxVelocity > 0) return Math.sign(to - from);
    if (path.maxReverseVelocity > 0) return Math.sign(from - to);
  }
  return 1;
}

function inFlowOrder(
  lanes: readonly (readonly PositionedSlot[])[],
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
  slots: readonly PositionedSlot[],
  laneAxis: LaneAxis,
): (readonly PositionedSlot[])[] {
  return crossLaneDirection(paths, memberPointNames, slots, laneAxis) >= 0
    ? [...lanes]
    : [...lanes].reverse();
}

export function isSlotLocation(
  layout: ZoneSlotLayout,
  target: string,
): boolean {
  return layout.lanes.some((lane) =>
    lane.slots.some((slot) => slot.locationName === target),
  );
}

export function laneIndexOfTarget(
  layout: ZoneSlotLayout,
  target: string,
): number | null {
  const index = layout.lanes.findIndex(
    (lane) =>
      lane.slots.some((slot) => slot.locationName === target) ||
      lane.axisPoints.includes(target),
  );
  return index === -1 ? null : index;
}

export function usableSlotCount(layout: ZoneSlotLayout): number {
  return layout.columns.reduce((total, column) => total + column.length, 0);
}

export function laneOfPoint(
  layout: ZoneSlotLayout,
  pointName: string,
): ZoneLane | null {
  return (
    layout.lanes.find((lane) =>
      lane.slots.some((slot) => slot.pointName === pointName),
    ) ?? null
  );
}

export function laneOfLocation(
  layout: ZoneSlotLayout,
  locationName: string,
): ZoneLane | null {
  return (
    layout.lanes.find((lane) =>
      lane.slots.some((slot) => slot.locationName === locationName),
    ) ?? null
  );
}

export function pointNamesOfLocations(
  layout: ZoneSlotLayout,
  locationNames: ReadonlySet<string>,
): Set<string> {
  const pointNames = new Set<string>();
  for (const lane of layout.lanes) {
    for (const slot of lane.slots) {
      if (locationNames.has(slot.locationName)) pointNames.add(slot.pointName);
    }
  }
  return pointNames;
}

export function columnIndexOfPoint(
  layout: ZoneSlotLayout,
  pointName: string,
): number | null {
  const index = layout.columns.findIndex((column) =>
    column.some((slot) => slot.pointName === pointName),
  );
  return index === -1 ? null : index;
}

export function columnLocationNames(
  layout: ZoneSlotLayout,
  columnIndex: number,
): ReadonlySet<string> {
  return new Set(
    (layout.columns[columnIndex] ?? []).map((slot) => slot.locationName),
  );
}

export function rankSlots(
  layout: ZoneSlotLayout,
  unavailableLocationNames: ReadonlySet<string>,
  activeCountByLane?: readonly number[],
): ZoneSlot[] {
  const taken = new Set(unavailableLocationNames);
  const filled = activeCountByLane
    ? [...activeCountByLane]
    : layout.columns.map(
        (column) =>
          column.filter((slot) => taken.has(slot.locationName)).length,
      );

  const fillOrder: ZoneSlot[] = [];
  for (;;) {
    const next = nextSlotToFill(layout, taken, filled);
    if (!next) return fillOrder;
    fillOrder.push(next.slot);
    taken.add(next.slot.locationName);
    filled[next.lane]++;
  }
}

function nextSlotToFill(
  layout: ZoneSlotLayout,
  taken: ReadonlySet<string>,
  filled: readonly number[],
): { slot: ZoneSlot; lane: number } | null {
  const { columns } = layout;
  if (columns.length === 0) return null;

  const eligible = eligibleColumns(filled);
  const firstEligible = eligible.indexOf(true);
  if (firstEligible === -1) return null;

  for (let index = firstEligible; index < columns.length; index++) {
    const empty = columns[index].find((slot) => !taken.has(slot.locationName));
    if (empty) return { slot: empty, lane: index };
  }
  return null;
}

export function eligibleLanes(filled: readonly number[]): boolean[] {
  return eligibleColumns(filled);
}

function eligibleColumns(filled: readonly number[]): boolean[] {
  const eligible = new Array<boolean>(filled.length).fill(false);
  eligible[filled.length - 1] = true;
  for (let index = filled.length - 2; index >= 0; index--) {
    eligible[index] =
      eligible[index + 1] &&
      filled[index] - filled[index + 1] < MAX_COLUMN_LEAD;
  }
  return eligible;
}
