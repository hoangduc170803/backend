import {
  TaskOrderState,
  type TaskOrderEntity,
} from '../../cargo/entities/task-order.entity';
import type { TransportOrderDto } from '../dto/operating.dto';

const STILL_OPEN: ReadonlySet<TaskOrderState> = new Set([
  TaskOrderState.ACTIVE,
  TaskOrderState.WITHDRAWING,
]);

function shownState(row: TaskOrderEntity): string {
  if (STILL_OPEN.has(row.state)) return row.kernelState;
  return row.state === TaskOrderState.FINISHED ? 'FINISHED' : 'FAILED';
}

export function toOrderDtoFromLedger(row: TaskOrderEntity): TransportOrderDto {
  return {
    name: row.orderName,
    type: row.leg,
    state: shownState(row),
    processingVehicle: row.startedAt ? row.vehicleName : null,
    intendedVehicle: row.vehicleName,
    wrappingSequence: null,
    destinations: (row.destinations ?? []).map((destination) => ({
      locationName: destination.locationName,
      operation: destination.operation,
    })),
    creationTime: row.createdAt.toISOString(),
    finishedTime:
      row.state === TaskOrderState.FINISHED
        ? (row.endedAt?.toISOString() ?? null)
        : null,
    taskId: row.taskId,
  };
}

interface LedgerHistoryEntry {
  timestamp: string;
  eventCode: string;
  supplements: string[];
}

function destinationState(row: TaskOrderEntity, index: number): string {
  const finished = row.finishedDestinations ?? 0;
  if (row.state === TaskOrderState.FINISHED || index < finished) {
    return 'FINISHED';
  }
  if (!STILL_OPEN.has(row.state)) return 'FAILED';
  return index === finished && row.startedAt ? 'TRAVELLING' : 'PRISTINE';
}

function driveOrdersFromLedger(row: TaskOrderEntity): unknown[] {
  return (row.destinations ?? []).map((destination, index) => ({
    name: `${row.orderName}-${index}`,
    state: destinationState(row, index),
    destination: {
      destination: destination.locationName,
      operation: destination.operation,
      properties: [],
    },
    route: null,
  }));
}

function historyFromLedger(row: TaskOrderEntity): LedgerHistoryEntry[] {
  const vehicle = row.vehicleName ? [row.vehicleName] : [];
  const outcome = [row.state, row.endReason, row.replacedBy].filter(
    (part): part is string => !!part,
  );
  return [
    { at: row.createdAt, eventCode: 'wes:orderIssued', supplements: vehicle },
    { at: row.startedAt, eventCode: 'wes:orderStarted', supplements: vehicle },
    { at: row.endedAt, eventCode: 'wes:orderEnded', supplements: outcome },
  ].flatMap(({ at, eventCode, supplements }) =>
    at ? [{ timestamp: at.toISOString(), eventCode, supplements }] : [],
  );
}

export function toOrderDetailFromLedger(
  row: TaskOrderEntity,
  live: Record<string, unknown> | null,
): Record<string, unknown> {
  const liveDriveOrders = Array.isArray(live?.driveOrders)
    ? live.driveOrders
    : null;
  const liveHistory = (live?.history as { entries?: unknown[] } | undefined)
    ?.entries;
  return {
    deadline: null,
    dispensable: false,
    peripheralReservationToken: null,
    dependencies: [],
    properties: [],
    currentDriveOrderIndex: Math.max(
      0,
      Math.min(
        row.finishedDestinations ?? 0,
        (row.destinations?.length ?? 1) - 1,
      ),
    ),
    ...(live ?? {}),
    ...toOrderDtoFromLedger(row),
    history: {
      entries: liveHistory?.length ? liveHistory : historyFromLedger(row),
    },
    driveOrders: liveDriveOrders?.length
      ? liveDriveOrders
      : driveOrdersFromLedger(row),
  };
}
