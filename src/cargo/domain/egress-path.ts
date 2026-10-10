import {
  computeEgressPoints,
  type PlantPath,
} from '../../zones/domain/zone-topology';
import type { ZoneLane, ZoneSlotLayout } from './zone-slot-layout';

export type EgressKind = 'lane exit' | 'zone exit';

export interface EgressCell {
  readonly pointName: string;
  readonly kind: EgressKind;
  readonly laneIndexes: readonly number[];
  readonly cellsOutOfLane: number | null;
}

export function laneExitCellsOf(lane: ZoneLane): string[] {
  const slotPoints = new Set(lane.slots.map((slot) => slot.pointName));
  return lane.axisPoints.filter((pointName) => !slotPoints.has(pointName));
}

export function egressCellsOf(
  layout: ZoneSlotLayout,
  paths: readonly PlantPath[],
): Map<string, EgressCell> {
  const cells = new Map<string, EgressCell>();

  for (const pointName of computeEgressPoints(paths, layout.memberPointNames)) {
    cells.set(pointName, {
      pointName,
      kind: 'zone exit',
      laneIndexes: [],
      cellsOutOfLane: null,
    });
  }

  for (const [laneIndex, lane] of layout.lanes.entries()) {
    for (const [step, pointName] of laneExitCellsOf(lane).entries()) {
      const known = cells.get(pointName);
      const shared = known?.kind === 'lane exit' ? known : null;
      cells.set(pointName, {
        pointName,
        kind: 'lane exit',
        laneIndexes: [...(shared?.laneIndexes ?? []), laneIndex],
        cellsOutOfLane: Math.min(shared?.cellsOutOfLane ?? step + 1, step + 1),
      });
    }
  }

  return cells;
}

export function egressCellHeldBy(
  cells: ReadonlyMap<string, EgressCell>,
  heldPointNames: readonly string[],
): EgressCell | null {
  for (const pointName of heldPointNames) {
    const cell = cells.get(pointName);
    if (cell) return cell;
  }
  return null;
}

export function describeEgressCell(cell: EgressCell): string {
  if (cell.kind === 'zone exit') {
    return `${cell.pointName} (a cell traffic leaves the zone through)`;
  }
  const lanes = cell.laneIndexes.join(' and ');
  const shared =
    cell.laneIndexes.length > 1 ? ', a cell those lanes share' : '';
  return `${cell.pointName} (${cell.cellsOutOfLane} cell(s) out of lane ${lanes}${shared})`;
}
