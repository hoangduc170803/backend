import type {
  AreaDto as Area,
  CargoDto as Cargo,
  OperatingCargoStatus as CargoStatus,
} from '../../dto/operating.dto';

const AT_SOURCE: ReadonlySet<CargoStatus> = new Set([
  'QUEUED',
  'BLOCKED',
  'PICK_PENDING',
  'PICKING',
]);
const FINISHED: ReadonlySet<CargoStatus> = new Set(['DONE', 'FAILED']);

export function freeZonePoints(
  zone: Area,
  cargos: readonly Cargo[],
): Set<string> {
  const taken = new Set(
    cargos.filter((c) => AT_SOURCE.has(c.status)).map((c) => c.pickupPointName),
  );
  return new Set(
    zone.members
      .filter((m) => m.state === 'FREE' && !taken.has(m.opentcsPointName))
      .map((m) => m.opentcsPointName),
  );
}

export interface StoreRoom {
  room: number;
  freeSlots: number;
  deliveredFull: boolean;
  finishedCargoIds: string[];
}

export function storeRoom(store: Area, cargos: readonly Cargo[]): StoreRoom {
  const byId = new Map(cargos.map((c) => [c.cargoId, c]));
  const slotCargoIds = new Set(
    store.members.flatMap((m) => (m.cargoId ? [m.cargoId] : [])),
  );
  const freeSlots = store.members.filter((m) => m.state === 'FREE').length;
  const pending = cargos.filter(
    (c) =>
      c.targetStoreAreaWesId === store.wesId &&
      !FINISHED.has(c.status) &&
      !slotCargoIds.has(c.cargoId),
  ).length;

  const finishedCargoIds = store.members.flatMap((member) => {
    if (member.state !== 'OCCUPIED' || !member.cargoId) return [];
    return byId.get(member.cargoId)?.status === 'DONE' ? [member.cargoId] : [];
  });
  return {
    room: freeSlots - pending,
    freeSlots,
    deliveredFull:
      store.members.length > 0 &&
      finishedCargoIds.length === store.members.length,
    finishedCargoIds,
  };
}
