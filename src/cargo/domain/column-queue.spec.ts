import {
  ColumnQueue,
  NOTHING_CLAIMED,
  targetOf,
  type ColumnClaims,
  type QueueNode,
} from './column-queue';

const COLUMN = ['0521', '0516', '0511', '0506', '0549'];
const SLOTS = new Set(['0521', '0516', '0511']);

function columnAt(pitch: number): QueueNode[] {
  return COLUMN.map((pointName, index) => ({
    pointName,
    locationName: SLOTS.has(pointName) ? `location_${pointName}` : null,
    along: index * pitch,
  }));
}

function claims(fields: Partial<ColumnClaims>): ColumnClaims {
  return { ...NOTHING_CLAIMED, ...fields };
}

const queueAt = (pitch: number, fields: Partial<ColumnClaims> = {}) =>
  ColumnQueue.of(columnAt(pitch), claims(fields));

describe('ColumnQueue.top', () => {
  it('starts at the deepest cell', () => {
    expect(targetOf(queueAt(750).top()!)).toBe('location_0521');
  });

  it('moves on once a pallet is finished on that cell', () => {
    const queue = queueAt(750, {
      finished: new Set(['location_0521', 'location_0516']),
    });

    expect(targetOf(queue.top()!)).toBe('location_0511');
  });

  it('has no top left once every cell is finished', () => {
    const queue = queueAt(750, {
      finished: new Set([
        'location_0521',
        'location_0516',
        'location_0511',
        '0506',
        '0549',
      ]),
    });

    expect(queue.top()).toBeNull();
  });
});

describe('ColumnQueue.next', () => {
  it('hands the deepest cell to the first arrival', () => {
    expect(targetOf(queueAt(750).next('reserve')!)).toBe('location_0521');
  });

  it('skips the cells the top will reverse through', () => {
    const queue = queueAt(750, { reserved: new Set(['location_0521']) });

    expect(targetOf(queue.next('reserve')!)).toBe('0549');
  });

  it('leaves nowhere once the retreat and the queue cell are both spoken for', () => {
    const queue = queueAt(750, {
      reserved: new Set(['location_0521', '0549']),
    });

    expect(queue.next('reserve')).toBeNull();
  });

  it('fits one more vehicle once the cells clear a whole body', () => {
    const queue = queueAt(1000, { reserved: new Set(['location_0521']) });

    expect(targetOf(queue.next('reserve')!)).toBe('0506');
  });

  it('offers a commit only on the top, and only when it is a real slot', () => {
    expect(targetOf(queueAt(750).next('commit')!)).toBe('location_0521');
  });

  it('commits on a cell somebody merely reserved, so a swap can happen', () => {
    const queue = queueAt(750, { reserved: new Set(['location_0521']) });

    expect(targetOf(queue.next('commit')!)).toBe('location_0521');
  });

  it('never reaches past a vehicle already standing in the lane', () => {
    const queue = queueAt(750, { committed: new Set(['location_0516']) });

    expect(targetOf(queue.next('commit')!)).toBe('location_0511');
  });

  it('reports the column full once the shallowest cell is taken', () => {
    const queue = queueAt(750, { committed: new Set(['location_0511']) });

    expect(queue.next('commit')).toBeNull();
  });

  it('never offers a cell beyond the column, so nothing parks on the mainline', () => {
    const queue = queueAt(750, {
      reserved: new Set(['location_0521', '0549']),
    });

    expect(queue.next('reserve')).toBeNull();
  });
});

describe('ColumnQueue.capacity', () => {
  it('holds two vehicles in a column pitched under one body length', () => {
    expect(queueAt(750).capacity()).toBe(2);
  });

  it('holds three once the pitch clears a whole body', () => {
    expect(queueAt(1000).capacity()).toBe(3);
  });

  it('shrinks as pallets pile up, because each one eats retreat room', () => {
    expect(
      queueAt(750, { finished: new Set(['location_0521']) }).capacity(),
    ).toBe(1);
    expect(
      queueAt(750, {
        finished: new Set(['location_0521', 'location_0516']),
      }).capacity(),
    ).toBe(1);
  });

  it('is zero when every cell already holds a pallet', () => {
    const queue = queueAt(750, {
      finished: new Set(['location_0521', 'location_0516', 'location_0511']),
    });

    expect(queue.capacity()).toBe(0);
  });
});

describe('ColumnQueue when the buffer cells belong to the mainline', () => {
  const slotsOnly = () =>
    ColumnQueue.of(columnAt(750).slice(0, 3), NOTHING_CLAIMED);

  it('still admits the first vehicle rather than shutting the column', () => {
    expect(slotsOnly().capacity()).toBe(1);
    expect(targetOf(slotsOnly().next('reserve')!)).toBe('location_0521');
  });

  it('offers nobody a second cell, because the retreat has to leave the column', () => {
    const queue = ColumnQueue.of(columnAt(750).slice(0, 3), {
      ...NOTHING_CLAIMED,
      reserved: new Set(['location_0521']),
    });

    expect(queue.next('reserve')).toBeNull();
  });
});

describe('ColumnQueue counts', () => {
  it('reports what it holds so the caller can pick between columns', () => {
    const queue = queueAt(750, {
      committed: new Set(['location_0521']),
      reserved: new Set(['0549']),
    });

    expect(queue.committedCount).toBe(1);
    expect(queue.reservedCount).toBe(1);
  });

  it('describes itself for the log when it turns a vehicle away', () => {
    const queue = queueAt(750, {
      reserved: new Set(['location_0521', '0549']),
    });

    expect(queue.describe()).toContain('2 reserved + 0 committed of 2');
    expect(queue.describe()).toContain('top location_0521');
    expect(queue.describe()).toContain('holding location_0521, 0549');
  });
});
