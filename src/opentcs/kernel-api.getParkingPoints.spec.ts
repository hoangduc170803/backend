import { KernelApiService } from './kernel-api.service';

describe('KernelApiService.getParkingPoints', () => {
  it('returns only PARK_POSITION points with parsed priority (array & object props)', async () => {
    const svc = new KernelApiService();
    jest.spyOn(svc, 'getRawPlantModel').mockResolvedValue({
      points: [
        { name: '0047', type: 'PARK_POSITION', properties: [] },
        {
          name: '1001',
          type: 'PARK_POSITION',
          properties: [{ key: 'tcs:parkingPositionPriority', value: '3' }],
        },
        { name: '3060', type: 'HALT_POSITION', properties: [] }, // not a park point
        {
          name: '1002',
          type: 'PARK_POSITION',
          // SSE-style object map form
          properties: { 'tcs:parkingPositionPriority': 5 },
        },
      ],
    });

    expect(await svc.getParkingPoints()).toEqual([
      { name: '0047', priority: null },
      { name: '1001', priority: 3 },
      { name: '1002', priority: 5 },
    ]);
  });

  it('returns [] when the plant model is unavailable', async () => {
    const svc = new KernelApiService();
    jest.spyOn(svc, 'getRawPlantModel').mockResolvedValue(null);
    expect(await svc.getParkingPoints()).toEqual([]);
  });
});
