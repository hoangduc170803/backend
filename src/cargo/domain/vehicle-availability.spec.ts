import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import { isEnRouteToPark, isFmsDispatchable } from './vehicle-availability';

const idle: KernelVehicleState = {
  name: 'V1',
  state: 'IDLE',
  procState: 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 80,
  paused: false,
  currentPosition: 'P1',
};

const parking: KernelVehicleState = {
  ...idle,
  state: 'EXECUTING',
  procState: 'PROCESSING_ORDER',
  transportOrder: 'PARK-V1-P2-test',
};

describe('vehicle availability', () => {
  it('distinguishes idle dispatch from parking preemption', () => {
    expect(isFmsDispatchable(idle)).toBe(true);
    expect(isEnRouteToPark(idle)).toBe(false);
    expect(isFmsDispatchable(parking)).toBe(false);
    expect(isEnRouteToPark(parking)).toBe(true);
    expect(isFmsDispatchable({ ...idle, procState: 'AWAITING_ORDER' })).toBe(
      false,
    );
  });

  it.each<KernelVehicleState['state']>([
    'UNKNOWN',
    'UNAVAILABLE',
    'ERROR',
    'CHARGING',
  ])('rejects %s despite retained processing state and position', (state) => {
    expect(isFmsDispatchable({ ...idle, state })).toBe(false);
    expect(isEnRouteToPark({ ...parking, state })).toBe(false);
  });

  it('requires an integrated vehicle with a known position for both paths', () => {
    for (const vehicle of [idle, parking]) {
      const check = vehicle === idle ? isFmsDispatchable : isEnRouteToPark;
      expect(check(undefined)).toBe(false);
      expect(check({ ...vehicle, currentPosition: null })).toBe(false);
      expect(check({ ...vehicle, integrationLevel: 'TO_BE_RESPECTED' })).toBe(
        false,
      );
    }
    expect(
      isEnRouteToPark({ ...parking, transportOrder: 'CHARGE-V1-test' }),
    ).toBe(false);
  });
});
