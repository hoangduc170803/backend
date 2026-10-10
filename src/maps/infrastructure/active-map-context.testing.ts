import type { ActiveMapContext } from './active-map-context.service';

export const TEST_MAP_ID = 'map-under-test';

export function fixedActiveMap(
  id: string | null = TEST_MAP_ID,
): ActiveMapContext {
  return { id: () => Promise.resolve(id) } as unknown as ActiveMapContext;
}
