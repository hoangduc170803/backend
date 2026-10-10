import { applySingleVehicleBlocks } from './apply-blocks';
import type { PlantModelDto } from '../map-loader/opentcs-xml.parser';

/** A minimal plant model with a J - p1 - p2 - p3(dead-end) lane off a junction. */
function modelWithDeadEndLane(): PlantModelDto {
  const bi = (a: string, b: string) => [
    {
      name: `${a} --- ${b}`,
      srcPointName: a,
      destPointName: b,
      length: 1,
      maxVelocity: 1,
      maxReverseVelocity: 1,
      locked: false,
      properties: [],
    },
    {
      name: `${b} --- ${a}`,
      srcPointName: b,
      destPointName: a,
      length: 1,
      maxVelocity: 1,
      maxReverseVelocity: 1,
      locked: false,
      properties: [],
    },
  ];
  return {
    name: 'test',
    points: [],
    paths: [
      ...bi('J', 'a1'),
      ...bi('J', 'a2'),
      ...bi('J', 'p1'),
      ...bi('p1', 'p2'),
      ...bi('p2', 'p3'),
    ],
    vehicles: [],
    locationTypes: [],
    locations: [],
    blocks: [],
    visualLayout: {
      name: 'v',
      scaleX: 1,
      scaleY: 1,
      layers: [],
      layerGroups: [],
      properties: [],
    },
  };
}

describe('applySingleVehicleBlocks', () => {
  it('populates blocks with a SINGLE_VEHICLE_ONLY block for the lane', () => {
    const model = applySingleVehicleBlocks(modelWithDeadEndLane());
    expect(model.blocks.length).toBeGreaterThan(0);
    expect(model.blocks.every((b) => b.type === 'SINGLE_VEHICLE_ONLY')).toBe(
      true,
    );
    expect(model.blocks.some((b) => b.memberNames.includes('p3'))).toBe(true);
  });

  it('is idempotent — re-running does not duplicate generated blocks', () => {
    const once = applySingleVehicleBlocks(modelWithDeadEndLane());
    const names1 = once.blocks.map((b) => b.name).sort();
    const twice = applySingleVehicleBlocks(once);
    const names2 = twice.blocks.map((b) => b.name).sort();
    expect(names2).toEqual(names1);
    expect(new Set(names2).size).toBe(names2.length);
  });

  it('preserves hand-authored (non-SVB) blocks and refreshes generated ones', () => {
    const model = modelWithDeadEndLane();
    model.blocks = [
      {
        name: 'manual-safety-zone',
        type: 'SINGLE_VEHICLE_ONLY',
        memberNames: ['x'],
      },
      { name: 'SVB-stale', type: 'SINGLE_VEHICLE_ONLY', memberNames: ['gone'] },
    ];
    const out = applySingleVehicleBlocks(model);
    expect(out.blocks.some((b) => b.name === 'manual-safety-zone')).toBe(true);
    expect(out.blocks.some((b) => b.name === 'SVB-stale')).toBe(false); // stale generated block dropped
    expect(out.blocks.some((b) => b.memberNames.includes('p3'))).toBe(true); // regenerated
  });
});
