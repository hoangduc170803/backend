import { VehicleAimService, type AimedVehicle } from './vehicle-aim.service';
import type { ZoneSlotLayout } from './domain/zone-slot-layout';

const ZONE = { id: 'zone-1', name: 'zone_1' } as never;
const SLOT = 'location_P1';
const CORRIDOR = 'corr';

const DEEPER = 'location_P0';
const OTHER_LANE = 'location_Q1';

const LANE = {
  axis: 0,
  slots: [
    { locationName: DEEPER, pointName: 'P0' },
    { locationName: SLOT, pointName: 'P1' },
  ],
  axisPoints: ['P0', 'P1', CORRIDOR],
  axisAlong: [0, 1000],
};

const LAYOUT: ZoneSlotLayout = {
  mainlinePoints: new Set<string>(),
  columns: [LANE.slots, [{ locationName: OTHER_LANE, pointName: 'Q1' }]],
  lanes: [
    LANE,
    {
      axis: 1000,
      slots: [{ locationName: OTHER_LANE, pointName: 'Q1' }],
      axisPoints: ['Q1', 'corrQ'],
      axisAlong: [0, 1000],
    },
  ],
  entryPoints: ['P1', 'Q1'],
  memberPointNames: new Set(['P0', 'P1', 'Q1']),
  strandedLocationNames: [],
};

function setup(
  metadata: Record<string, unknown> = {},
  drivingOrder: string | null = null,
) {
  const slotReservation = {
    claimCell: jest.fn().mockResolvedValue({ previous: null }),
    restoreClaim: jest.fn().mockResolvedValue(undefined),
    releaseCommit: jest.fn().mockResolvedValue(undefined),
  };
  const approachOrder = {
    aim: jest.fn().mockResolvedValue('APPROACH-new'),
    cancel: jest.fn((task: { metadata: Record<string, unknown> }) => {
      task.metadata = { ...task.metadata, approachOrderName: undefined };
      return Promise.resolve();
    }),
  };
  const dropoffOrder = {
    issue: jest.fn().mockResolvedValue('DROPOFF-new'),
    reissue: jest.fn().mockResolvedValue('DROPOFF-new'),
    cancel: jest.fn((task: { metadata: Record<string, unknown> }) => {
      task.metadata = { ...task.metadata, dropoffOrderName: undefined };
      return Promise.resolve();
    }),
  };
  const vehicle = { transportOrder: drivingOrder };
  const vehicleStore = { get: jest.fn(() => vehicle) };
  const taskRepo = { save: jest.fn((task: unknown) => Promise.resolve(task)) };
  const taskOrders = {
    latestActiveOrder: jest.fn().mockResolvedValue(null),
  };
  const service = new VehicleAimService(
    slotReservation as never,
    approachOrder as never,
    dropoffOrder as never,
    vehicleStore as never,
    taskRepo as never,
    taskOrders as never,
  );
  const aimed: AimedVehicle = {
    task: { id: 'task-1', metadata } as never,
    vehicle: 'V1',
    cargoId: 'cargo-1',
  };
  return {
    service,
    slotReservation,
    approachOrder,
    dropoffOrder,
    aimed,
    vehicle,
  };
}

describe('queueAt', () => {
  it('claims the cell before asking the kernel for the order', async () => {
    const { service, slotReservation, approachOrder, aimed } = setup();

    await service.queueAt(aimed, ZONE, LAYOUT, CORRIDOR);

    expect(slotReservation.claimCell.mock.invocationCallOrder[0]).toBeLessThan(
      approachOrder.aim.mock.invocationCallOrder[0],
    );
    expect(slotReservation.claimCell).toHaveBeenCalledWith(
      'cargo-1',
      CORRIDOR,
      ZONE,
    );
  });

  it('never orders a vehicle to a cell another cargo holds', async () => {
    const { service, slotReservation, approachOrder, aimed } = setup();
    slotReservation.claimCell.mockResolvedValueOnce(null);

    expect(await service.queueAt(aimed, ZONE, LAYOUT, CORRIDOR)).toBe(false);
    expect(approachOrder.aim).not.toHaveBeenCalled();
  });

  it('gives the cell back when the order cannot be created', async () => {
    const { service, slotReservation, approachOrder, aimed } = setup();
    slotReservation.claimCell.mockResolvedValueOnce({ previous: SLOT });
    approachOrder.aim.mockResolvedValueOnce(null);

    expect(await service.queueAt(aimed, ZONE, LAYOUT, CORRIDOR)).toBe(false);
    expect(slotReservation.restoreClaim).toHaveBeenCalledWith(
      'cargo-1',
      SLOT,
      ZONE,
    );
  });

  it('sends a drop-off cell as a location and a corridor point as a point', async () => {
    const { service, approachOrder, aimed } = setup();

    await service.queueAt(aimed, ZONE, LAYOUT, SLOT);
    await service.queueAt(aimed, ZONE, LAYOUT, CORRIDOR);

    expect(approachOrder.aim.mock.calls[0][2]).toEqual({ locationName: SLOT });
    expect(approachOrder.aim.mock.calls[1][2]).toEqual({
      pointName: CORRIDOR,
    });
  });
});

describe('dropAt', () => {
  it('cancels the approach order even when the cell is further along the same lane', async () => {
    const { service, approachOrder, aimed } = setup({
      approachPointName: SLOT,
    });

    expect(await service.dropAt(aimed, ZONE, DEEPER, false)).toBe(true);
    expect(approachOrder.cancel).toHaveBeenCalledWith(aimed.task);
  });

  it('keeps it when the commit landed exactly where it was already heading', async () => {
    const { service, approachOrder, aimed } = setup({
      approachPointName: SLOT,
    });

    await service.dropAt(aimed, ZONE, SLOT, true);

    expect(approachOrder.cancel).not.toHaveBeenCalled();
  });

  it('cancels when the commit landed in a different lane', async () => {
    const { service, approachOrder, aimed } = setup({
      approachPointName: SLOT,
    });

    await service.dropAt(aimed, ZONE, OTHER_LANE, false);

    expect(approachOrder.cancel).toHaveBeenCalled();
  });

  it('cancels when the commit is behind where it was heading', async () => {
    const { service, approachOrder, aimed } = setup({
      approachPointName: DEEPER,
    });

    await service.dropAt(aimed, ZONE, SLOT, false);

    expect(approachOrder.cancel).toHaveBeenCalled();
  });

  it('cancels only after the drop-off order exists', async () => {
    const { service, dropoffOrder, approachOrder, aimed } = setup({
      approachPointName: SLOT,
    });

    await service.dropAt(aimed, ZONE, OTHER_LANE, false);

    expect(dropoffOrder.issue.mock.invocationCallOrder[0]).toBeLessThan(
      approachOrder.cancel.mock.invocationCallOrder[0],
    );
  });

  it('reuses the order in flight when the commit kept its own reservation', async () => {
    const { service, dropoffOrder, aimed } = setup({
      dropoffOrderName: 'DROPOFF-old',
      approachPointName: SLOT,
    });

    expect(await service.dropAt(aimed, ZONE, SLOT, true)).toBe(true);
    expect(dropoffOrder.issue).not.toHaveBeenCalled();
    expect(dropoffOrder.reissue).not.toHaveBeenCalled();
  });

  it('re-issues the order when the commit landed somewhere else', async () => {
    const { service, dropoffOrder, aimed } = setup({
      dropoffOrderName: 'DROPOFF-old',
    });

    await service.dropAt(aimed, ZONE, SLOT, false);

    expect(dropoffOrder.reissue).toHaveBeenCalledWith(
      aimed.task,
      'V1',
      SLOT,
      ZONE,
    );
  });

  it('gives the slot back when the kernel refuses the order', async () => {
    const { service, dropoffOrder, slotReservation, aimed } = setup();
    dropoffOrder.issue.mockResolvedValueOnce(null);

    expect(await service.dropAt(aimed, ZONE, SLOT, false)).toBe(false);
    expect(slotReservation.releaseCommit).toHaveBeenCalledWith('cargo-1', ZONE);
  });

  it('keeps the vehicle on its approach order when the drop-off is refused', async () => {
    const { service, dropoffOrder, approachOrder, aimed } = setup({
      approachPointName: OTHER_LANE,
    });
    dropoffOrder.issue.mockResolvedValueOnce(null);

    await service.dropAt(aimed, ZONE, SLOT, false);

    expect(approachOrder.cancel).not.toHaveBeenCalled();
  });
});

describe('stopApproaching', () => {
  it('withdraws the approach order so the cell stops being claimed', async () => {
    const { service, approachOrder, aimed } = setup({
      approachPointName: SLOT,
    });

    await service.stopApproaching(aimed);

    expect(approachOrder.cancel).toHaveBeenCalledWith(aimed.task);
  });
});

describe('hand-over from an order the vehicle is still driving', () => {
  const driving = (metadata: Record<string, unknown>, order: string) =>
    setup({ assignedVehicleName: 'V1', ...metadata }, order);

  it('withdraws the approach first and holds the drop-off back', async () => {
    const { service, approachOrder, dropoffOrder, aimed } = driving(
      { approachOrderName: 'APPROACH-old', approachPointName: SLOT },
      'APPROACH-old',
    );

    expect(await service.dropAt(aimed, ZONE, OTHER_LANE, false)).toBe(true);

    expect(approachOrder.cancel).toHaveBeenCalledWith(aimed.task);
    expect(dropoffOrder.issue).not.toHaveBeenCalled();
    expect(aimed.task.metadata.pendingDropoff).toMatchObject({
      slot: OTHER_LANE,
      zoneId: 'zone-1',
      waitFor: 'APPROACH-old',
    });
  });

  it('withdraws a drop-off in flight before re-aiming it', async () => {
    const { service, dropoffOrder, aimed } = driving(
      { dropoffOrderName: 'DROPOFF-old' },
      'DROPOFF-old',
    );

    expect(await service.dropAt(aimed, ZONE, SLOT, false)).toBe(true);

    expect(dropoffOrder.cancel).toHaveBeenCalledWith(aimed.task);
    expect(dropoffOrder.reissue).not.toHaveBeenCalled();
    expect(aimed.task.metadata.pendingDropoff?.waitFor).toBe('DROPOFF-old');
  });

  it('gives the slot back when the order in flight cannot be withdrawn', async () => {
    const { service, approachOrder, slotReservation, aimed } = driving(
      { approachOrderName: 'APPROACH-old', approachPointName: SLOT },
      'APPROACH-old',
    );
    approachOrder.cancel.mockResolvedValueOnce(undefined);

    expect(await service.dropAt(aimed, ZONE, OTHER_LANE, false)).toBe(false);
    expect(slotReservation.releaseCommit).toHaveBeenCalledWith('cargo-1', ZONE);
  });

  it('keeps waiting while the vehicle still runs the withdrawn order', async () => {
    const { service, dropoffOrder, aimed } = driving(
      { approachOrderName: 'APPROACH-old', approachPointName: SLOT },
      'APPROACH-old',
    );
    await service.dropAt(aimed, ZONE, OTHER_LANE, false);
    Object.assign(aimed.task, { cargoId: 'cargo-1' });

    expect(await service.issueDeferredDropoff(aimed.task, ZONE)).toBe(
      'waiting',
    );
    expect(dropoffOrder.issue).not.toHaveBeenCalled();
  });

  it('sends the drop-off once the withdrawn order has ended', async () => {
    const { service, dropoffOrder, aimed, vehicle } = driving(
      { approachOrderName: 'APPROACH-old', approachPointName: SLOT },
      'APPROACH-old',
    );
    await service.dropAt(aimed, ZONE, OTHER_LANE, false);
    Object.assign(aimed.task, { cargoId: 'cargo-1' });
    vehicle.transportOrder = null;

    expect(await service.issueDeferredDropoff(aimed.task, ZONE)).toBe('issued');
    expect(dropoffOrder.issue).toHaveBeenCalledWith(
      aimed.task,
      'V1',
      OTHER_LANE,
      ZONE,
    );
    expect(aimed.task.metadata.pendingDropoff).toBeUndefined();
  });

  it('stops waiting after the hand-over deadline', async () => {
    const { service, dropoffOrder, aimed } = driving(
      {
        pendingDropoff: {
          slot: SLOT,
          zoneId: 'zone-1',
          waitFor: 'APPROACH-old',
          since: new Date(Date.now() - 61_000).toISOString(),
        },
      },
      'APPROACH-old',
    );
    Object.assign(aimed.task, { cargoId: 'cargo-1' });

    expect(await service.issueDeferredDropoff(aimed.task, ZONE)).toBe('issued');
    expect(dropoffOrder.issue).toHaveBeenCalled();
  });

  it('issues at once when the vehicle is not driving the old order', async () => {
    const { service, dropoffOrder, approachOrder, aimed } = driving(
      { approachOrderName: 'APPROACH-old', approachPointName: SLOT },
      null as unknown as string,
    );

    await service.dropAt(aimed, ZONE, OTHER_LANE, false);

    expect(dropoffOrder.issue).toHaveBeenCalled();
    expect(approachOrder.cancel).toHaveBeenCalled();
  });
});
