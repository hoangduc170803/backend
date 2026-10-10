import { seatTheQueue } from './queue-assignment';

const NOBODY_ELSE = new Set<string>();

const seat = (reserved: string | null, id: string) => ({ reserved, id });

describe('seatTheQueue', () => {
  it('leaves a vehicle on the cell it already holds', () => {
    const waiting = [seat('D2', 'v1'), seat('D1', 'v2')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, NOBODY_ELSE);

    expect(seated.map((s) => s.target)).toEqual(['D2', 'D1']);
  });

  it('keeps the same answer when the vehicles are read in the other order', () => {
    const forwards = [seat('D2', 'v1'), seat('D1', 'v2')];
    const backwards = [seat('D1', 'v2'), seat('D2', 'v1')];

    const a = seatTheQueue(['D2', 'D1'], forwards, NOBODY_ELSE);
    const b = seatTheQueue(['D2', 'D1'], backwards, NOBODY_ELSE);

    expect(byId(a)).toEqual(byId(b));
  });

  it('fills the cells nobody holds, deepest waiter first', () => {
    const waiting = [seat(null, 'v1'), seat(null, 'v2')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, NOBODY_ELSE);

    expect(seated.map((s) => s.target)).toEqual(['D2', 'D1']);
  });

  it('never offers a cell another cargo holds', () => {
    const waiting = [seat(null, 'v1')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, new Set(['D2']));

    expect(seated[0].target).toBe('D1');
  });

  it('moves a vehicle whose cell left the chain', () => {
    const waiting = [seat('D3', 'v1'), seat('D1', 'v2')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, NOBODY_ELSE);

    expect(byId(seated)).toEqual({ v1: 'D2', v2: 'D1' });
  });

  it('moves a vehicle off a cell that was handed to someone else', () => {
    const waiting = [seat('D1', 'v1')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, new Set(['D1']));

    expect(seated[0].target).toBe('D2');
  });

  it('reports nothing for the vehicles the chain cannot fit', () => {
    const waiting = [seat(null, 'v1'), seat(null, 'v2'), seat(null, 'v3')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, NOBODY_ELSE);

    expect(seated.map((s) => s.target)).toEqual(['D2', 'D1', null]);
  });

  it('never seats two vehicles on the same cell', () => {
    const waiting = [seat('D1', 'v1'), seat('D1', 'v2')];

    const seated = seatTheQueue(['D2', 'D1'], waiting, NOBODY_ELSE);

    expect(byId(seated)).toEqual({ v1: 'D1', v2: 'D2' });
  });

  it('gives nobody anything when the chain is empty', () => {
    const seated = seatTheQueue([], [seat('D1', 'v1')], NOBODY_ELSE);

    expect(seated[0].target).toBeNull();
  });
});

function byId(
  seated: { entry: { id: string }; target: string | null }[],
): Record<string, string | null> {
  return Object.fromEntries(seated.map((s) => [s.entry.id, s.target]));
}
