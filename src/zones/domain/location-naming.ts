export const LOCATION_PREFIX = 'location_';

export function pointNameOf(locationName: string): string {
  return locationName.startsWith(LOCATION_PREFIX)
    ? locationName.slice(LOCATION_PREFIX.length)
    : locationName;
}
