import axios from 'axios';
import { KernelApiService } from './kernel-api.service';

const CREATED = {
  data: { name: 'ORDER', state: 'RAW', destinations: [] },
};

const parkOrderName = (vehicle: string, point: string) =>
  `PARK-${vehicle}-${point}-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5`;

function spyOnPost(): jest.Mock {
  const post = jest.spyOn(axios, 'post') as unknown as jest.Mock;
  post.mockResolvedValue(CREATED);
  return post;
}

function spyOnGet(payload: unknown): jest.Mock {
  const get = jest.spyOn(axios, 'get') as unknown as jest.Mock;
  get.mockResolvedValue({ data: payload });
  return get;
}

function createdBody(post: jest.Mock): Record<string, unknown> {
  return post.mock.calls[0][1] as Record<string, unknown>;
}

describe('KernelApiService.createTransportOrder dispensable', () => {
  afterEach(() => jest.restoreAllMocks());

  it('triggers the dispatcher through the openTCS v1 endpoint after creation', async () => {
    const post = spyOnPost();

    await new KernelApiService().createTransportOrder(
      'ORDER-V1-POINT',
      [{ locationName: 'POINT-1', operation: 'MOVE' }],
      'V1',
    );

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/v1/transportOrders/dispatcher/trigger'),
      null,
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('marks the order dispensable when the caller asks for it', async () => {
    const post = spyOnPost();

    await new KernelApiService().createTransportOrder(
      parkOrderName('V1', '1002'),
      [{ locationName: '1002', operation: 'MOVE' }],
      'V1',
      { 'wes:leg': 'PARK' },
      { dispensable: true },
    );

    expect(createdBody(post).dispensable).toBe(true);
  });

  it('defaults to not dispensable for cargo, charge and approach orders', async () => {
    const post = spyOnPost();

    await new KernelApiService().createTransportOrder(
      'PICKUP-V1-LOC-1-uuid',
      [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
      'V1',
    );

    expect(createdBody(post).dispensable).toBe(false);
  });
});

describe('KernelApiService.getTransportOrderStateStrict', () => {
  afterEach(() => jest.restoreAllMocks());

  function rejectGet(err: unknown): void {
    const get = jest.spyOn(axios, 'get') as unknown as jest.Mock;
    get.mockRejectedValue(err);
  }

  it('returns the state the kernel reports', async () => {
    spyOnGet({ name: 'ORDER', state: 'DISPATCHABLE' });

    await expect(
      new KernelApiService().getTransportOrderStateStrict('ORDER'),
    ).resolves.toBe('DISPATCHABLE');
  });

  it('returns null only when the kernel says the order does not exist', async () => {
    rejectGet({ isAxiosError: true, response: { status: 404 } });

    await expect(
      new KernelApiService().getTransportOrderStateStrict('ORDER'),
    ).resolves.toBeNull();
  });

  it('throws when the kernel is unreachable, so a claim is never dropped on a blip', async () => {
    rejectGet(new Error('connect ECONNREFUSED'));

    await expect(
      new KernelApiService().getTransportOrderStateStrict('ORDER'),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('throws on a server error rather than reporting the order as gone', async () => {
    rejectGet({ isAxiosError: true, response: { status: 500 } });

    await expect(
      new KernelApiService().getTransportOrderStateStrict('ORDER'),
    ).rejects.toBeDefined();
  });

  it('throws when a 200 carries no state', async () => {
    spyOnGet({ name: 'ORDER' });

    await expect(
      new KernelApiService().getTransportOrderStateStrict('ORDER'),
    ).rejects.toThrow(/no state/);
  });
});
