import type { TransportOrderDestination } from '../../opentcs/domain/kernel-model';
import type { TaskOrderEntity } from '../entities/task-order.entity';

export interface LoadOperations {
  load: string;
  unload: string;
}

type ProgressedOrder = Pick<
  TaskOrderEntity,
  'destinations' | 'finishedDestinations'
>;

function alreadyDoneOnTheVehicle(
  destination: TransportOrderDestination,
  vehicleLoaded: boolean | null,
  operations: LoadOperations,
): boolean {
  if (vehicleLoaded === null) return false;
  if (destination.operation === operations.load) return vehicleLoaded;
  if (destination.operation === operations.unload) return !vehicleLoaded;
  return false;
}

export function remainingDestinations(
  order: ProgressedOrder,
  vehicleLoaded: boolean | null,
  operations: LoadOperations,
): TransportOrderDestination[] | null {
  if (!order.destinations?.length) return null;
  const notReported = order.destinations.slice(
    Math.max(0, order.finishedDestinations ?? 0),
  );
  const [interrupted, ...untouched] = notReported;
  if (!interrupted) return [];
  return alreadyDoneOnTheVehicle(interrupted, vehicleLoaded, operations)
    ? untouched
    : notReported;
}
