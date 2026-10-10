import type { TransportOrderDto } from '../dto/operating.dto';
import { ORDER_PROP } from '../../opentcs/domain/transport-order';

export interface RawOrder {
  name?: string;
  type?: string;
  state?: string;
  processingVehicle?: string | null;
  intendedVehicle?: string | null;
  wrappingSequence?: string | null;
  destinations?: { locationName?: string; operation?: string }[];
  properties?: { key?: string; value?: string }[];
  creationTime?: string | null;
  /** openTCS reports `Instant.MAX` (a far-future sentinel) until an order actually finishes. */
  finishedTime?: string | null;
  currentDriveOrderIndex?: number;
  currentRouteStepIndex?: number;
  driveOrders?: {
    route?: {
      steps?: { routeIndex?: number; destinationPoint?: string }[];
    } | null;
  }[];
}

export interface RouteStep {
  point: string;
  driven: boolean;
}

export interface RouteProgress {
  /** Point names still ahead of the vehicle on this order — for the route highlight. */
  points: string[];
  /** % of the order's total route steps already driven, rounded (0 when the route has no steps). */
  percent: number;
  /** Every route step in order, each flagged as already driven or still ahead. */
  steps: RouteStep[];
}

/** openTCS's sentinel `Instant.MAX` doesn't parse as a JS Date — treat it as "not finished". */
export function realInstant(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  return iso;
}

export function toTransportOrderDto(order: RawOrder): TransportOrderDto {
  return {
    name: order.name ?? '',
    type: order.type ?? '',
    state: order.state ?? '',
    processingVehicle: order.processingVehicle ?? null,
    intendedVehicle: order.intendedVehicle ?? null,
    wrappingSequence: order.wrappingSequence ?? null,
    destinations: (order.destinations ?? []).map((destination) => ({
      locationName: destination.locationName ?? '',
      operation: destination.operation ?? '',
    })),
    creationTime: order.creationTime ?? null,
    finishedTime: realInstant(order.finishedTime),
    taskId:
      (order.properties ?? []).find(
        (property) => property.key === ORDER_PROP.TASK_ID,
      )?.value ?? null,
  };
}

/**
 * Remaining route points plus % complete for a transport order — every drive-order route step is
 * either already driven (counts toward `percent`) or still ahead (added to `points`). A `null`
 * order (not found / kernel error) is treated as a route with no progress and no steps, matching
 * the caller's existing `.catch(() => null)` fallback.
 */
export function computeRouteProgress(order: RawOrder | null): RouteProgress {
  const points: string[] = [];
  const steps: RouteStep[] = [];
  let totalSteps = 0;
  let drivenSteps = 0;

  if (order) {
    const currentDrive = order.currentDriveOrderIndex ?? 0;
    const currentStep = order.currentRouteStepIndex ?? -1;
    (order.driveOrders ?? []).forEach((driveOrder, driveIndex) => {
      const routeSteps = driveOrder.route?.steps ?? [];
      totalSteps += routeSteps.length;
      for (const step of routeSteps) {
        const driven =
          driveIndex < currentDrive ||
          (driveIndex === currentDrive &&
            (step.routeIndex ?? 0) <= currentStep);
        if (driven) {
          drivenSteps += 1;
        } else if (step.destinationPoint) {
          points.push(step.destinationPoint);
        }
        if (step.destinationPoint) {
          steps.push({ point: step.destinationPoint, driven });
        }
      }
    });
  }

  const percent =
    totalSteps > 0 ? Math.round((drivenSteps / totalSteps) * 100) : 0;
  return { points, percent, steps };
}
