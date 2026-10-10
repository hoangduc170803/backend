import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import {
  ORDER_KIND,
  orderNamePrefix,
} from '../../opentcs/domain/transport-order';

const PARK_ORDER_PREFIX = orderNamePrefix(ORDER_KIND.PARK);

function isFmsReady(
  state: KernelVehicleState | undefined,
): state is KernelVehicleState {
  return (
    state !== undefined &&
    state.integrationLevel === 'TO_BE_UTILIZED' &&
    (state.state === 'IDLE' || state.state === 'EXECUTING') &&
    state.currentPosition != null
  );
}

export function isFmsDispatchable(
  state: KernelVehicleState | undefined,
): boolean {
  return isFmsReady(state) && state.procState === 'IDLE';
}

export function isEnRouteToPark(
  state: KernelVehicleState | undefined,
): boolean {
  return (
    isFmsReady(state) &&
    state.procState === 'PROCESSING_ORDER' &&
    (state.transportOrder?.startsWith(PARK_ORDER_PREFIX) ?? false)
  );
}

export function isIntegrated(state: KernelVehicleState | undefined): boolean {
  return state?.integrationLevel === 'TO_BE_UTILIZED';
}
