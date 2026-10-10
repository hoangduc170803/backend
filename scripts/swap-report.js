/* eslint-disable */
// @ts-nocheck

'use strict';

const USAGE = `usage: node scripts/swap-report.js [--run N | --from A --to B] [--pitch MM] [--json]`;

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const out = { pitch: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--pitch') out.pitch = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function resolveWindow(db, args) {
  if (args.from && args.to) {
    const r = await db.query(
      'SELECT min(started_at) AS started_at, max(coalesce(ended_at, now())) AS ended_at FROM runs WHERE id BETWEEN $1 AND $2',
      [args.from, args.to],
    );
    return { label: `runs ${args.from}..${args.to}`, ...r.rows[0] };
  }
  const r = args.run
    ? await db.query('SELECT * FROM runs WHERE id = $1', [args.run])
    : await db.query('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  if (r.rows.length === 0) return null;
  const run = r.rows[0];
  return {
    label: `run ${run.id} (${run.label})`,
    started_at: run.started_at,
    ended_at: run.ended_at ?? new Date(),
  };
}

const ASSIGNS_SQL = `
  SELECT task_id,
         (context->>'batchSize')::int AS batch_size,
         (context->>'distanceToSource')::numeric AS planned_mm,
         (context->>'swapCount')::int AS swap_count,
         row_number() OVER (
           PARTITION BY task_id ORDER BY occurred_at DESC, id DESC
         ) AS leg_rank
  FROM task_status_transitions
  WHERE trigger = 'ASSIGNMENT_ENGINE' AND to_status = 'PICKING_UP'
    AND context ? 'batchSize'
    AND occurred_at BETWEEN $1 AND $2`;

const HANDOVERS_SQL = `
  WITH revokes AS (
    SELECT task_id, vehicle_name AS from_vehicle, occurred_at,
           (context->>'swapCount')::int AS swap_count,
           context->>'toVehicleName' AS to_vehicle
    FROM task_status_transitions
    WHERE trigger = 'ASSIGNMENT_ENGINE' AND to_status = 'READY_TO_ASSIGN'
      AND context->>'swap' = 'true'
      AND occurred_at BETWEEN $1 AND $2
  )
  SELECT r.task_id, r.from_vehicle, r.to_vehicle, r.swap_count,
         r.occurred_at AS revoked_at, a.occurred_at AS assigned_at,
         a.planned_mm,
         coalesce((
           SELECT count(*) FROM (
             SELECT point_name,
                    lag(point_name) OVER (ORDER BY occurred_at, id) AS prev
             FROM vehicle_state_transitions v
             WHERE v.vehicle_name = r.from_vehicle
               AND v.point_name IS NOT NULL
               AND v.occurred_at BETWEEN a.occurred_at AND r.occurred_at
           ) hops
           WHERE prev IS NOT NULL AND point_name <> prev
         ), 0) AS hops
  FROM revokes r
  LEFT JOIN LATERAL (
    SELECT occurred_at, (context->>'distanceToSource')::numeric AS planned_mm
    FROM task_status_transitions a
    WHERE a.task_id = r.task_id AND a.to_status = 'PICKING_UP'
      AND a.occurred_at <= r.occurred_at
    ORDER BY a.occurred_at DESC LIMIT 1
  ) a ON true
  ORDER BY r.occurred_at`;

const PREEMPTS_SQL = `
  SELECT count(*)::int AS n
  FROM task_status_transitions
  WHERE to_status = 'BLOCKED' AND context->>'preempted' = 'true'
    AND occurred_at BETWEEN $1 AND $2`;

const pct = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index];
};

const m = (mm) => (mm == null ? '—' : `${(mm / 1000).toFixed(1)}m`);

function summarise(assigns, handovers, preempts, pitch) {
  const byBatch = new Map();
  for (const row of assigns) {
    const key = row.batch_size ?? 0;
    byBatch.set(key, (byBatch.get(key) ?? 0) + 1);
  }

  const perTask = new Map();
  for (const row of handovers) {
    perTask.set(row.task_id, (perTask.get(row.task_id) ?? 0) + 1);
  }

  const drivenMm = handovers.map((row) => Number(row.hops) * pitch);
  const shares = handovers
    .map((row, index) =>
      row.planned_mm > 0 ? drivenMm[index] / Number(row.planned_mm) : null,
    )
    .filter((share) => share !== null);

  const isFinalLeg = (row) => Number(row.leg_rank) === 1;
  const sumPlanned = (rows) =>
    rows.reduce((sum, row) => sum + Number(row.planned_mm ?? 0), 0);
  const finalLegs = assigns.filter(isFinalLeg);
  const plannedDeadheadMm = sumPlanned(finalLegs);
  const supersededPlannedMm = sumPlanned(assigns.filter((r) => !isFinalLeg(r)));
  const wastedMm = drivenMm.reduce((sum, value) => sum + value, 0);

  return {
    assigns: assigns.length,
    tasks: finalLegs.length,
    handovers: handovers.length,
    tasksHandedOver: perTask.size,
    handoversPerTask: finalLegs.length
      ? handovers.length / finalLegs.length
      : 0,
    thrashTasks: [...perTask.values()].filter((count) => count >= 2).length,
    maxHandoversOnOneTask: Math.max(0, ...perTask.values()),
    lanePreempts: preempts,
    batchSizes: [...byBatch.entries()].sort((a, b) => a[0] - b[0]),
    batchOneShare: assigns.length
      ? (byBatch.get(1) ?? 0) / assigns.length
      : 0,
    drivenP50: pct(drivenMm, 0.5),
    drivenP90: pct(drivenMm, 0.9),
    shareP50: pct(shares, 0.5),
    shareP90: pct(shares, 0.9),
    lateHandovers: shares.filter((share) => share > 0.7).length,
    earlyHandovers: shares.filter((share) => share < 0.3).length,
    plannedDeadheadMm,
    supersededPlannedMm,
    wastedMm,
    trueDeadheadMm: plannedDeadheadMm + wastedMm,
  };
}

function print(window, s) {
  console.log(`\n=== pickup swaps — ${window.label} ===`);
  console.log(
    `tasks ${s.tasks}   dispatch decisions ${s.assigns}   lane preempts ${s.lanePreempts}`,
  );
  console.log(
    `handovers ${s.handovers} on ${s.tasksHandedOver} task(s) = ${s.handoversPerTask.toFixed(2)}/task   thrash (>=2x) ${s.thrashTasks}   worst task ${s.maxHandoversOnOneTask}`,
  );

  console.log(`\n-- batch size --`);
  console.log(`batch=1 share ${(s.batchOneShare * 100).toFixed(1)}%`);
  for (const [size, count] of s.batchSizes) {
    console.log(
      `  ${String(size).padStart(3)}  ${String(count).padStart(5)}  ${((count / s.assigns) * 100).toFixed(1)}%`,
    );
  }

  console.log(`\n-- how late the handover came --`);
  console.log(`driven before revoke   p50 ${m(s.drivenP50)}   p90 ${m(s.drivenP90)}`);
  console.log(
    `share of the leg       p50 ${s.shareP50 == null ? '—' : (s.shareP50 * 100).toFixed(0) + '%'}   p90 ${s.shareP90 == null ? '—' : (s.shareP90 * 100).toFixed(0) + '%'}`,
  );
  console.log(
    `  <30% driven ${s.earlyHandovers}   >70% driven ${s.lateHandovers}   (thresholds fixed 2026-07-14)`,
  );

  console.log(`\n-- deadhead, abandoned legs INCLUDED --`);
  console.log(`executed leg   ${m(s.plannedDeadheadMm)}   (final leg of each task)`);
  console.log(`superseded     ${m(s.supersededPlannedMm)}   (planned, never completed)`);
  console.log(`wasted         ${m(s.wastedMm)}   (actually driven before revoke)`);
  console.log(
    `TRUE           ${m(s.trueDeadheadMm)}   (executed + wasted, +${s.plannedDeadheadMm ? ((s.wastedMm / s.plannedDeadheadMm) * 100).toFixed(2) : '0.00'}% overhead)`,
  );
  console.log('');
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const window = await resolveWindow(db, args);
    if (!window) {
      console.error('no matching runs');
      process.exit(1);
    }
    const bounds = [window.started_at, window.ended_at];
    const assigns = (await db.query(ASSIGNS_SQL, bounds)).rows;
    const handovers = (await db.query(HANDOVERS_SQL, bounds)).rows;
    const preempts = (await db.query(PREEMPTS_SQL, bounds)).rows[0].n;
    const summary = summarise(assigns, handovers, preempts, args.pitch);
    if (args.json) {
      console.log(JSON.stringify({ window: window.label, ...summary }, null, 2));
    } else {
      print(window, summary);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
