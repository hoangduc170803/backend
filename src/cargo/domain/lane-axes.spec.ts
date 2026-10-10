import {
  axesOf,
  clusterKeys,
  projectOnto,
  wayIntoZone,
  type BoundaryEdge,
} from './lane-axes';

function edge(
  outside: [number, number],
  inside: [number, number],
  enterable: boolean,
): BoundaryEdge {
  return {
    outside: { x: outside[0], y: outside[1] },
    inside: { x: inside[0], y: inside[1] },
    enterable,
  };
}

describe('wayIntoZone', () => {
  it('reports nothing when the zone has no boundary at all', () => {
    expect(wayIntoZone([])).toBeNull();
  });

  it('drops one-way exits even when they outnumber the entrances', () => {
    const exits = [
      edge([6400, -7250], [5450, -7250], false),
      edge([6400, -8050], [5450, -8050], false),
      edge([6400, -8850], [5450, -8850], false),
    ];
    const entrances = [
      edge([5450, -6450], [5450, -7250], true),
      edge([4500, -6450], [4500, -7250], true),
    ];

    expect(wayIntoZone([...exits, ...entrances])).toEqual(entrances);
  });

  it('falls back to the boundary when no edge can be entered', () => {
    const outward = [edge([6400, -7250], [5450, -7250], false)];

    expect(wayIntoZone(outward)).toEqual(outward);
  });

  it('keeps the most common direction when entrances disagree', () => {
    const many = [
      edge([0, 0], [0, 800], true),
      edge([950, 0], [950, 800], true),
    ];
    const odd = edge([2000, 800], [1200, 800], true);

    expect(wayIntoZone([odd, ...many])).toEqual(many);
  });
});

describe('axesOf', () => {
  it('puts the aisle behind the entrance and the depth axis pointing in', () => {
    const axes = axesOf([
      edge([5450, -6450], [5450, -7250], true),
      edge([4500, -6450], [4500, -7250], true),
    ]);

    expect(axes.aisleCenter).toEqual({ x: 4975, y: -6450 });
    expect(axes.depth).toEqual({ x: 0, y: -1 });
    expect(axes.lane).toEqual({ x: 1, y: 0 });
  });

  it('grows depth with distance from the aisle', () => {
    const axes = axesOf([edge([5450, -6450], [5450, -7250], true)]);

    const near = projectOnto(axes, { x: 5450, y: -7250 });
    const far = projectOnto(axes, { x: 5450, y: -8850 });

    expect(near.depth).toBe(800);
    expect(far.depth).toBe(2400);
    expect(near.lane).toBe(far.lane);
  });
});

describe('clusterKeys', () => {
  it('keeps a 800 pitch apart instead of folding it onto a 1000 grid', () => {
    const keys = clusterKeys([800, 1600, 2400, 3200]);

    expect(new Set(keys.values()).size).toBe(4);
  });

  it('keeps two lanes 950 apart distinct', () => {
    const keys = clusterKeys([-475, 475]);

    expect(keys.get(-475)).not.toBe(keys.get(475));
  });

  it('folds jitter below the noise floor into one key', () => {
    const keys = clusterKeys([0, 40, 800]);

    expect(keys.get(0)).toBe(keys.get(40));
    expect(keys.get(0)).not.toBe(keys.get(800));
  });

  it('returns an empty map for no values', () => {
    expect(clusterKeys([]).size).toBe(0);
  });
});
