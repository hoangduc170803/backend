import { pointNameOf } from './location-naming';

describe('pointNameOf', () => {
  it('reads the point a WES-created location sits on', () => {
    expect(pointNameOf('location_0521')).toBe('0521');
  });

  it('leaves a name that was not built from a point alone', () => {
    expect(pointNameOf('Charging-1')).toBe('Charging-1');
  });

  it('strips only the leading prefix', () => {
    expect(pointNameOf('location_location_1')).toBe('location_1');
  });
});
