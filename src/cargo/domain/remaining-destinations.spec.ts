import { remainingDestinations } from './remaining-destinations';

const OPERATIONS = { load: 'liftUp', unload: 'liftDown' };
const move = (locationName: string) => ({ locationName, operation: 'MOVE' });
const names = (destinations: { locationName: string }[] | null) =>
  (destinations ?? []).map((destination) => destination.locationName);

describe('remainingDestinations', () => {
  it('replays the whole order when nothing was reported finished', () => {
    const order = {
      destinations: [move('A'), move('B'), move('C')],
      finishedDestinations: 0,
    };

    expect(names(remainingDestinations(order, null, OPERATIONS))).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('resumes a three-point order from the point it was driving to', () => {
    const order = {
      destinations: [move('A'), move('B'), move('C')],
      finishedDestinations: 1,
    };

    expect(names(remainingDestinations(order, false, OPERATIONS))).toEqual([
      'B',
      'C',
    ]);
  });

  it('has nothing left once every destination was reported finished', () => {
    const order = { destinations: [move('A')], finishedDestinations: 1 };

    expect(remainingDestinations(order, null, OPERATIONS)).toEqual([]);
  });

  it('does not lift again when the vehicle already carries the load', () => {
    const order = {
      destinations: [{ locationName: 'PICK', operation: 'liftUp' }],
      finishedDestinations: 0,
    };

    expect(remainingDestinations(order, true, OPERATIONS)).toEqual([]);
    expect(names(remainingDestinations(order, false, OPERATIONS))).toEqual([
      'PICK',
    ]);
  });

  it('does not lower again when the vehicle already put the load down', () => {
    const order = {
      destinations: [
        { locationName: 'SLOT', operation: 'liftDown' },
        move('RETREAT'),
      ],
      finishedDestinations: 0,
    };

    expect(names(remainingDestinations(order, false, OPERATIONS))).toEqual([
      'RETREAT',
    ]);
    expect(names(remainingDestinations(order, true, OPERATIONS))).toEqual([
      'SLOT',
      'RETREAT',
    ]);
  });

  it('keeps the interrupted load operation when the load state is unknown', () => {
    const order = {
      destinations: [{ locationName: 'SLOT', operation: 'liftDown' }],
      finishedDestinations: 0,
    };

    expect(names(remainingDestinations(order, null, OPERATIONS))).toEqual([
      'SLOT',
    ]);
  });

  it('only second-guesses the destination that was interrupted, not later ones', () => {
    const order = {
      destinations: [
        move('A'),
        { locationName: 'SLOT', operation: 'liftDown' },
      ],
      finishedDestinations: 0,
    };

    expect(names(remainingDestinations(order, false, OPERATIONS))).toEqual([
      'A',
      'SLOT',
    ]);
  });

  it('cannot say what is left of an order recorded without its destinations', () => {
    const order = { destinations: [], finishedDestinations: 0 };

    expect(remainingDestinations(order, true, OPERATIONS)).toBeNull();
  });
});
