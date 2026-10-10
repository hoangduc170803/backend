import {
  columnUpToMainline,
  standsWithoutAnOrder,
  vehicleAheadInLane,
  vehicleParkedInColumn,
} from './column-occupancy';

describe('columnUpToMainline', () => {
  it('keeps walking behind the slots up to and including the first mainline point', () => {
    expect(
      columnUpToMainline(
        ['0521', '0516'],
        ['0511', '0532', '0549', '0005'],
        new Set(['0532', '0549', '0005']),
      ),
    ).toEqual(['0521', '0516', '0511', '0532']);
  });

  it('takes the whole chain when it never reaches a mainline', () => {
    expect(columnUpToMainline(['D1'], ['W1', 'W2'], new Set())).toEqual([
      'D1',
      'W1',
      'W2',
    ]);
  });
});

describe('standsWithoutAnOrder', () => {
  it.each([
    ['IDLE', undefined, true],
    ['AWAITING_ORDER', null, true],
    ['IDLE', 'PARK-V1-P1', false],
    ['PROCESSING_ORDER', 'DROPOFF-V1-D1', false],
    ['UNAVAILABLE', null, false],
  ])('%s with order %s → %s', (procState, transportOrder, expected) => {
    expect(
      standsWithoutAnOrder({
        name: 'V1',
        currentPosition: 'W1',
        procState: procState,
        transportOrder: transportOrder,
      }),
    ).toBe(expected);
  });
});

describe('vehicleParkedInColumn', () => {
  const column = new Set(['D1', 'W1']);

  it('finds an orderless vehicle standing anywhere in the column', () => {
    expect(
      vehicleParkedInColumn(
        [{ name: 'V9', currentPosition: 'W1', procState: 'IDLE' }],
        column,
        'V1',
      )?.name,
    ).toBe('V9');
  });

  it('skips the requester and vehicles outside the column', () => {
    expect(
      vehicleParkedInColumn(
        [
          { name: 'V1', currentPosition: 'W1', procState: 'IDLE' },
          { name: 'V8', currentPosition: 'S1', procState: 'IDLE' },
          { name: 'V7', currentPosition: null, procState: 'IDLE' },
        ],
        column,
        'V1',
      ),
    ).toBeNull();
  });
});

describe('vehicleAheadInLane', () => {
  const lane = {
    axisPoints: ['D3', 'D2', 'D1', 'WD1', 'WD2'],
  };

  it('finds a deeper vehicle with an order', () => {
    const blockingVehicle = {
      name: 'V9',
      currentPosition: 'D1',
      procState: 'PROCESSING_ORDER',
      transportOrder: 'DROPOFF-V9-D3',
    };

    expect(vehicleAheadInLane([blockingVehicle], lane, 'V1', 'WD1')).toBe(
      blockingVehicle,
    );
  });

  it('finds a deeper idle vehicle', () => {
    const blockingVehicle = {
      name: 'V9',
      currentPosition: 'D1',
      procState: 'IDLE',
    };

    expect(vehicleAheadInLane([blockingVehicle], lane, 'V1', 'WD1')).toBe(
      blockingVehicle,
    );
  });

  it.each([
    { procState: 'IDLE', transportOrder: null },
    { procState: 'PROCESSING_ORDER', transportOrder: 'PARK-V9-P1' },
  ])('ignores a vehicle behind the requester: $procState', (state) => {
    expect(
      vehicleAheadInLane(
        [
          {
            name: 'V9',
            currentPosition: 'WD2',
            ...state,
          },
        ],
        lane,
        'V1',
        'WD1',
      ),
    ).toBeNull();
  });

  it('ignores a vehicle off the lane axis', () => {
    expect(
      vehicleAheadInLane(
        [{ name: 'V9', currentPosition: 'A1', procState: 'IDLE' }],
        lane,
        'V1',
        'WD1',
      ),
    ).toBeNull();
  });

  it('ignores the requester', () => {
    expect(
      vehicleAheadInLane(
        [{ name: 'V1', currentPosition: 'D1', procState: 'IDLE' }],
        lane,
        'V1',
        'WD1',
      ),
    ).toBeNull();
  });

  it('ignores vehicles without a current position', () => {
    expect(
      vehicleAheadInLane(
        [{ name: 'V9', currentPosition: null, procState: 'IDLE' }],
        lane,
        'V1',
        'WD1',
      ),
    ).toBeNull();
  });

  it('blocks any other vehicle on the axis when the requester is off the axis', () => {
    const blockingVehicle = {
      name: 'V9',
      currentPosition: 'WD2',
      procState: 'IDLE',
    };

    expect(vehicleAheadInLane([blockingVehicle], lane, 'V1', 'A1')).toBe(
      blockingVehicle,
    );
  });

  it('returns the first vehicle in the fleet that is deeper than the requester', () => {
    const deeperVehicle = {
      name: 'V8',
      currentPosition: 'D2',
      procState: 'IDLE',
    };

    expect(
      vehicleAheadInLane(
        [
          { name: 'V7', currentPosition: 'WD2', procState: 'IDLE' },
          deeperVehicle,
          { name: 'V6', currentPosition: 'D3', procState: 'IDLE' },
        ],
        lane,
        'V1',
        'D1',
      ),
    ).toBe(deeperVehicle);
  });
});
