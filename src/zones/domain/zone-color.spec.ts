import { ZONE_COLOR_PALETTE, pickLeastUsedColor } from './zone-color';

describe('pickLeastUsedColor', () => {
  it('takes the first colour when nothing is in use yet', () => {
    expect(pickLeastUsedColor(ZONE_COLOR_PALETTE, [])).toBe(
      ZONE_COLOR_PALETTE[0],
    );
  });

  it('skips a colour that is already taken', () => {
    const used = [ZONE_COLOR_PALETTE[0]];

    expect(pickLeastUsedColor(ZONE_COLOR_PALETTE, used)).toBe(
      ZONE_COLOR_PALETTE[1],
    );
  });

  it('starts reusing the earliest colour once every one is taken', () => {
    expect(
      pickLeastUsedColor(ZONE_COLOR_PALETTE, [...ZONE_COLOR_PALETTE]),
    ).toBe(ZONE_COLOR_PALETTE[0]);
  });

  it('prefers the colour used fewest times, not the one used longest ago', () => {
    const used = [
      ...ZONE_COLOR_PALETTE,
      ZONE_COLOR_PALETTE[0],
      ZONE_COLOR_PALETTE[1],
    ];

    expect(pickLeastUsedColor(ZONE_COLOR_PALETTE, used)).toBe(
      ZONE_COLOR_PALETTE[2],
    );
  });

  it('ignores colours that are in use but not in the palette', () => {
    expect(pickLeastUsedColor(ZONE_COLOR_PALETTE, ['#123456'])).toBe(
      ZONE_COLOR_PALETTE[0],
    );
  });
});
