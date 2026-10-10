import {
  ORDER_KIND,
  ORDER_PROP,
  buildOrderName,
  destinationFromOrderName,
  orderNamePrefix,
  orderProperties,
  parkPointFromOrderName,
} from './transport-order';

const UUID = '0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5';

describe('transport order name', () => {
  it('formats every order kind as KIND-vehicle-destination-uuid', () => {
    expect(buildOrderName(ORDER_KIND.PARK, 'Vehicle-0012', '1012', UUID)).toBe(
      `PARK-Vehicle-0012-1012-${UUID}`,
    );
    expect(
      buildOrderName(ORDER_KIND.CHARGE, 'Vehicle-0003', 'Charger-A', UUID),
    ).toBe(`CHARGE-Vehicle-0003-Charger-A-${UUID}`);
    expect(
      buildOrderName(ORDER_KIND.PICKUP, 'Vehicle-0007', 'Feeder-2', UUID),
    ).toBe(`PICKUP-Vehicle-0007-Feeder-2-${UUID}`);
    expect(
      buildOrderName(ORDER_KIND.APPROACH, 'Vehicle-0011', '0086', UUID),
    ).toBe(`APPROACH-Vehicle-0011-0086-${UUID}`);
    expect(
      buildOrderName(ORDER_KIND.DROPOFF, 'Vehicle-0009', 'Drop-3', UUID),
    ).toBe(`DROPOFF-Vehicle-0009-Drop-3-${UUID}`);
  });

  it('round-trips the destination for every order kind', () => {
    for (const kind of Object.values(ORDER_KIND)) {
      const name = buildOrderName(kind, 'Vehicle-0012', 'Dest-9', UUID);

      expect(destinationFromOrderName(kind, name, 'Vehicle-0012')).toBe(
        'Dest-9',
      );
    }
  });

  it('round-trips a destination containing hyphens', () => {
    const name = buildOrderName(
      ORDER_KIND.PARK,
      'Vehicle-0001',
      'PARK-1',
      UUID,
    );

    expect(parkPointFromOrderName(name, 'Vehicle-0001')).toBe('PARK-1');
  });

  it('does not confuse one order kind for another', () => {
    const charge = buildOrderName(
      ORDER_KIND.CHARGE,
      'Vehicle-0012',
      'Charger-A',
      UUID,
    );

    expect(parkPointFromOrderName(charge, 'Vehicle-0012')).toBeNull();
    expect(
      destinationFromOrderName(ORDER_KIND.CHARGE, charge, 'Vehicle-0012'),
    ).toBe('Charger-A');
  });

  it('returns null for an order belonging to another vehicle', () => {
    const name = buildOrderName(ORDER_KIND.PARK, 'Vehicle-0012', '1012', UUID);

    expect(parkPointFromOrderName(name, 'Vehicle-0013')).toBeNull();
  });

  it('rejects an order whose vehicle name merely shares a prefix', () => {
    const name = buildOrderName(ORDER_KIND.PARK, 'Vehicle-00121', '1012', UUID);

    expect(parkPointFromOrderName(name, 'Vehicle-0012')).toBeNull();
  });

  it('misreads a destination only if asked about a vehicle that does not own the order — the engine always passes the owner', () => {
    const name = buildOrderName(ORDER_KIND.PARK, 'V1-spare', '1012', UUID);

    expect(parkPointFromOrderName(name, 'V1')).toBe('spare-1012');
  });

  it('returns null when the vehicle has no order', () => {
    expect(parkPointFromOrderName(null, 'Vehicle-0012')).toBeNull();
    expect(parkPointFromOrderName(undefined, 'Vehicle-0012')).toBeNull();
  });

  it('returns null for a legacy name with no encoded destination', () => {
    expect(parkPointFromOrderName(`PARK-${UUID}`, 'Vehicle-0012')).toBeNull();
  });

  it('prefixes a name with the kind the parser looks for', () => {
    for (const kind of Object.values(ORDER_KIND)) {
      expect(
        buildOrderName(kind, 'Vehicle-0012', 'Dest-9', UUID).startsWith(
          orderNamePrefix(kind),
        ),
      ).toBe(true);
    }
  });
});

describe('transport order properties', () => {
  it('stamps the leg with the order kind, so the two can never disagree', () => {
    for (const kind of Object.values(ORDER_KIND)) {
      expect(orderProperties(kind, 'task-1')[ORDER_PROP.LEG]).toBe(kind);
    }
  });

  it('carries the task id back from the kernel when the order belongs to a task', () => {
    expect(orderProperties(ORDER_KIND.PICKUP, 'task-1')).toEqual({
      [ORDER_PROP.TASK_ID]: 'task-1',
      [ORDER_PROP.LEG]: 'PICKUP',
    });
  });

  it('omits the task id for fleet orders that belong to no task', () => {
    expect(orderProperties(ORDER_KIND.PARK)).toEqual({
      [ORDER_PROP.LEG]: 'PARK',
    });
    expect(orderProperties(ORDER_KIND.CHARGE)).toEqual({
      [ORDER_PROP.LEG]: 'CHARGE',
    });
  });

  it('keeps the wire names the kernel event listener reads back', () => {
    expect(ORDER_PROP.TASK_ID).toBe('wes:taskId');
    expect(ORDER_PROP.LEG).toBe('wes:leg');
  });
});
