import { VehicleStateStore } from './vehicle-state.store';
import type { KernelVehicleState } from './domain/kernel-model';

function vehicleState(
  overrides: Partial<KernelVehicleState> = {},
): KernelVehicleState {
  return {
    name: 'V1',
    state: 'IDLE',
    procState: 'IDLE',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 90,
    paused: false,
    currentPosition: null,
    transportOrder: null,
    ...overrides,
  };
}

describe('VehicleStateStore.getEventStats', () => {
  it('starts at zero with no last-event time', () => {
    const store = new VehicleStateStore();

    expect(store.getEventStats()).toEqual({ eventCount: 0, lastEventAt: null });
  });

  it('counts a real, de-duplicated update and records when it happened', () => {
    const store = new VehicleStateStore();

    store.set('V1', vehicleState({ currentPosition: 'P1' }));

    const stats = store.getEventStats();
    expect(stats.eventCount).toBe(1);
    expect(stats.lastEventAt).not.toBeNull();
  });

  it('does not count a repeat of the exact same state (fingerprint-deduped)', () => {
    const store = new VehicleStateStore();

    store.set('V1', vehicleState({ currentPosition: 'P1' }));
    store.set('V1', vehicleState({ currentPosition: 'P1' }));

    expect(store.getEventStats().eventCount).toBe(1);
  });

  it('counts a genuine change as a second event', () => {
    const store = new VehicleStateStore();

    store.set('V1', vehicleState({ currentPosition: 'P1' }));
    store.set('V1', vehicleState({ currentPosition: 'P2' }));

    expect(store.getEventStats().eventCount).toBe(2);
  });
});
