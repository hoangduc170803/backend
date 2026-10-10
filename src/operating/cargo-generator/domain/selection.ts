import type {
  AreaDto as Area,
  CargoDto as Cargo,
  PlantModelPathDto as PlantModelPath,
  PlantModelPointDto as PlantModelPoint,
} from '../../dto/operating.dto';
import { freeZonePoints, storeRoom } from './occupancy';
import type { PickLane, Random } from './pick-strategy';
import { zoneLanes } from './zone-lanes';

export interface PooledZones {
  lanes: PickLane[];
  zoneOfPoint: Map<string, Area>;
}

export function poolZones(
  zones: readonly Area[],
  points: readonly PlantModelPoint[],
  paths: readonly PlantModelPath[],
): PooledZones {
  const zoneOfPoint = new Map<string, Area>();
  const lanes: PickLane[] = [];
  for (const zone of zones) {
    const own = zone.members
      .map((m) => m.opentcsPointName)
      .filter((name) => !zoneOfPoint.has(name));
    for (const name of own) zoneOfPoint.set(name, zone);
    for (const lane of zoneLanes(own, points, paths)) {
      lanes.push({
        key: `${zone.wesId}:${lane.key}`,
        pointNames: lane.pointNames,
      });
    }
  }
  return { lanes, zoneOfPoint };
}

export function freePointsAcross(
  zones: readonly Area[],
  cargos: readonly Cargo[],
): Set<string> {
  const free = new Set<string>();
  for (const zone of zones) {
    for (const name of freeZonePoints(zone, cargos)) free.add(name);
  }
  return free;
}

export function storesWithRoom(
  stores: readonly Area[],
  cargos: readonly Cargo[],
  reportedFull: ReadonlySet<string> = new Set(),
): Area[] {
  return stores.filter(
    (store) =>
      !reportedFull.has(store.wesId) && storeRoom(store, cargos).room > 0,
  );
}

export function pickStore(
  candidates: readonly Area[],
  random: Random = Math.random,
): Area | null {
  if (candidates.length === 0) return null;
  return candidates[
    Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  ];
}
