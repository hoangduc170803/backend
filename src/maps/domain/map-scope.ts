import { IsIn, IsOptional, IsUUID } from 'class-validator';

export const MAP_SCOPES = ['loaded', 'all'] as const;
export type MapScope = (typeof MAP_SCOPES)[number];

/**
 * Query params shared by every list that can be read either for the map loaded in openTCS
 * (the default — what the Operating screen works on) or across the whole database.
 * `mapRecordId` narrows to one specific library map and wins over `scope`.
 */
export class MapScopeQueryDto {
  @IsOptional()
  @IsIn(MAP_SCOPES)
  scope?: MapScope;

  @IsOptional()
  @IsUUID()
  mapRecordId?: string;
}

/**
 * Which map records a list may return rows for.
 * `ids: null` = every row in the database, including legacy rows that carry no map at all.
 */
export interface MapFilter {
  ids: string[] | null;
  /** The map loaded in openTCS right now — lets the caller flag rows it can act on. */
  loadedMapId: string | null;
}

/**
 * Resolves a list request against the loaded map and the caller's AUTH-3 map scope
 * (`userMapIds === undefined` = unrestricted). A scoped caller never widens past its own maps,
 * and "all" for a scoped caller never includes rows without a map.
 */
export function resolveMapFilter(
  query: MapScopeQueryDto | undefined,
  loadedMapId: string | null,
  userMapIds: readonly string[] | undefined,
): MapFilter {
  const allowed = (id: string | null): string[] =>
    id && (userMapIds === undefined || userMapIds.includes(id)) ? [id] : [];

  if (query?.mapRecordId) {
    return { ids: allowed(query.mapRecordId), loadedMapId };
  }
  if (query?.scope === 'all') {
    return {
      ids: userMapIds === undefined ? null : [...userMapIds],
      loadedMapId,
    };
  }
  return { ids: allowed(loadedMapId), loadedMapId };
}

/** True when a row stamped with `mapRecordId` passes the filter. */
export function inMapFilter(
  filter: MapFilter,
  mapRecordId: string | null,
): boolean {
  if (filter.ids === null) return true;
  return mapRecordId !== null && filter.ids.includes(mapRecordId);
}
