import { MigrationInterface, QueryRunner } from 'typeorm';

interface ZoneRow {
  id: string;
  name: string;
  plant_model_name: string;
}

interface RecordCandidate {
  id: string;
  last_loaded_at: Date | null;
}

/**
 * Same decision as `resolveBackfillMatch` (src/zones/domain/map-record-backfill.ts), inlined
 * rather than imported: a migration's behaviour must stay fixed at the moment it ran, even if
 * that helper's logic changes later for new code paths.
 */
function resolveMatch(candidates: RecordCandidate[]): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  const everLoaded = candidates.filter((c) => c.last_loaded_at !== null);
  if (everLoaded.length === 0) return null;
  const [latest] = [...everLoaded].sort(
    (a, b) => b.last_loaded_at!.getTime() - a.last_loaded_at!.getTime(),
  );
  if (
    everLoaded.filter(
      (c) => c.last_loaded_at!.getTime() === latest.last_loaded_at!.getTime(),
    ).length !== 1
  )
    return null;
  return latest.id;
}

/**
 * One-time backfill of `zones.map_record_id` from the pre-existing `plant_model_name` string.
 * Only resolves a zone when its name maps to exactly one `map_records` row, or to exactly one
 * *most-recently-loaded* row among several same-named ones (see `resolveMatch`). Everything else
 * — no matching record, or several same-named records that were never loaded, so there's no
 * signal to prefer one — is left NULL and printed below for manual follow-up. This is
 * deliberate: a wrong guess would silently misattribute the zone's geometry to the wrong map.
 */
export class BackfillZoneMapRecordId1814000000000 implements MigrationInterface {
  name = 'BackfillZoneMapRecordId1814000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const zones = (await queryRunner.query(
      `SELECT id, name, plant_model_name FROM zones
       WHERE map_record_id IS NULL AND plant_model_name IS NOT NULL AND deleted_at IS NULL`,
    )) as ZoneRow[];
    if (zones.length === 0) {
      console.log('BackfillZoneMapRecordId: no zone needs backfilling.');
      return;
    }

    const byMapName = new Map<string, ZoneRow[]>();
    for (const zone of zones) {
      const list = byMapName.get(zone.plant_model_name) ?? [];
      list.push(zone);
      byMapName.set(zone.plant_model_name, list);
    }

    let resolvedCount = 0;
    const unresolved: { mapName: string; zoneNames: string[] }[] = [];

    for (const [mapName, zonesForName] of byMapName) {
      const candidates = (await queryRunner.query(
        `SELECT id, last_loaded_at FROM map_records WHERE name = $1`,
        [mapName],
      )) as RecordCandidate[];
      const matchId = resolveMatch(candidates);

      if (matchId) {
        await queryRunner.query(
          `UPDATE zones SET map_record_id = $1 WHERE id = ANY($2::uuid[])`,
          [matchId, zonesForName.map((z) => z.id)],
        );
        resolvedCount += zonesForName.length;
      } else {
        unresolved.push({
          mapName,
          zoneNames: zonesForName.map((z) => z.name),
        });
      }
    }

    console.log(
      `BackfillZoneMapRecordId: resolved ${resolvedCount} zone(s) across ${byMapName.size - unresolved.length} map name(s).`,
    );
    if (unresolved.length > 0) {
      console.warn(
        `BackfillZoneMapRecordId: ${unresolved.length} map name(s) left unresolved — multiple` +
          ' candidate records with no unique "most recently loaded" one. Review and assign manually:',
      );
      for (const { mapName, zoneNames } of unresolved) {
        console.warn(`  - "${mapName}": zone(s) ${zoneNames.join(', ')}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill is a best-effort data repair, not a schema change — reverting it would throw away
    // a manual re-run's chance to redo the same (idempotent) matching, so this is a no-op.
    await queryRunner.query('SELECT 1');
  }
}
