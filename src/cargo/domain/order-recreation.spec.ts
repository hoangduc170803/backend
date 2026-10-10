import {
  MAX_ORDER_RECREATIONS,
  ORDER_RECREATION_WINDOW_MS,
  recreationsInWindow,
  spendRecreation,
} from './order-recreation';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 9) + ms);

describe('spendRecreation', () => {
  it('allows the first recreations and counts them', () => {
    const first = spendRecreation(undefined, 'O1', at(0));
    expect(first).toMatchObject({ allowed: true, next: { count: 1 } });
    if (!first.allowed) return;
    const second = spendRecreation(first.next, 'O2', at(1000));
    expect(second).toMatchObject({
      allowed: true,
      next: {
        count: 2,
        windowStartedAt: first.next.windowStartedAt,
        lastOrderName: 'O2',
      },
    });
  });

  it('refuses once the limit is spent inside the window', () => {
    const budget = {
      count: MAX_ORDER_RECREATIONS,
      windowStartedAt: at(0).toISOString(),
      lastOrderName: 'O3',
    };
    expect(spendRecreation(budget, 'O4', at(60_000))).toEqual({
      allowed: false,
      spent: MAX_ORDER_RECREATIONS,
    });
  });

  it('starts a fresh window after the old one has passed', () => {
    const budget = {
      count: MAX_ORDER_RECREATIONS,
      windowStartedAt: at(0).toISOString(),
      lastOrderName: 'O3',
    };
    const later = at(ORDER_RECREATION_WINDOW_MS + 1);
    expect(spendRecreation(budget, 'O4', later)).toMatchObject({
      allowed: true,
      next: { count: 1, windowStartedAt: later.toISOString() },
    });
    expect(recreationsInWindow(budget, later)).toBe(0);
    expect(recreationsInWindow(budget, at(1000))).toBe(MAX_ORDER_RECREATIONS);
  });
});
