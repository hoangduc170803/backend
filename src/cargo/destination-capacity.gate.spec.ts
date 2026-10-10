import { DestinationCapacityGate } from './destination-capacity.gate';
import type { CargoEntity } from './entities/cargo.entity';

const cargoTo = (zoneId: string | null) =>
  ({ destinationZoneId: zoneId }) as CargoEntity;

function setup(options: { queueable: number; alreadyHeading: number }) {
  const heading = Array.from({ length: options.alreadyHeading }, (_, i) => ({
    id: `heading-${i}`,
    destinationZoneId: 'zone-A',
  }));
  const taskRepo = {
    find: jest.fn().mockResolvedValue(heading.map((c) => ({ cargoId: c.id }))),
  };
  const cargoRepo = { find: jest.fn().mockResolvedValue(heading) };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'zone-A', name: 'A' }),
  };
  const slotReservation = {
    queueableSlots: jest.fn().mockResolvedValue(options.queueable),
  };
  const gate = new DestinationCapacityGate(
    taskRepo as never,
    cargoRepo as never,
    zoneRepo as never,
    slotReservation as never,
  );
  return { gate, slotReservation };
}

describe('DestinationCapacityGate', () => {
  it('admits pick-ups while the zone still has slots beyond the loads already heading there', async () => {
    const { gate } = setup({ queueable: 3, alreadyHeading: 1 });
    const round = await gate.openRound('map-1');

    expect(await round.admit(cargoTo('zone-A'))).toBe(true);
    expect(await round.admit(cargoTo('zone-A'))).toBe(true);
    expect(await round.admit(cargoTo('zone-A'))).toBe(false);
  });

  it('holds every pick-up for a zone whose free slots are all spoken for', async () => {
    const { gate } = setup({ queueable: 2, alreadyHeading: 2 });
    const round = await gate.openRound('map-1');

    expect(await round.admit(cargoTo('zone-A'))).toBe(false);
  });

  it('asks the zone once per round', async () => {
    const { gate, slotReservation } = setup({
      queueable: 5,
      alreadyHeading: 0,
    });
    const round = await gate.openRound('map-1');

    await round.admit(cargoTo('zone-A'));
    await round.admit(cargoTo('zone-A'));

    expect(slotReservation.queueableSlots).toHaveBeenCalledTimes(1);
  });

  it('does not judge a cargo with no destination zone', async () => {
    const { gate } = setup({ queueable: 0, alreadyHeading: 0 });
    const round = await gate.openRound('map-1');

    expect(await round.admit(cargoTo(null))).toBe(true);
  });
});
