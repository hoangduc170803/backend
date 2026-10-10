/* eslint-disable */
// @ts-nocheck
/**
 * Analysis side of the evaluation harness: reads one or more `runs`, cuts the
 * transition tables by each run's [started_at, ended_at] window, and prints
 * evaluation metrics. run-scenario.js writes; this reads.
 *
 *   node scripts/analyze.js --run 3
 *   node scripts/analyze.js --label gate-check_batch10   # all runs w/ that label
 *   node scripts/analyze.js                              # most recent run
 *   node scripts/analyze.js --run 3 --json               # machine-readable
 *
 * All timestamps are on the Postgres clock (runs + every transition table), so
 * window cuts are frame-consistent even when the Docker/host clocks disagree.
 * A run whose clock JUMPED mid-window (ended_at <= started_at, or a negative
 * dwell inside a session) is flagged UNRELIABLE and skipped from aggregates.
 *
 * Metric definitions (operational — tune to taste):
 *   - latency          CREATED → DELIVERY_COMPLETED per task
 *   - assign_wait      time a task sat in READY_TO_ASSIGN before PICKING_UP
 *   - blocked_time     time a task sat in BLOCKED (release-engine gate)
 *   - preempts         BLOCKED transitions with context.preempted = true
 *   - dist_to_source   Dijkstra distance vehicle→source at assignment (proxy
 *                      for assignment quality: lower = better matching)
 *   - interference f   fleet time with an order but not moving, over total time
 *                      with an order: sum(dwell | PROCESSING_ORDER & !EXECUTING)
 *                      / sum(dwell | PROCESSING_ORDER)
 */

'use strict';

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
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--json') out.json = true;
    else out._.push(a);
  }
  return out;
}

const n = (v, d = 1) => (v == null ? null : Number(Number(v).toFixed(d)));
const fmt = (v, unit = '') => (v == null ? '—' : `${n(v)}${unit}`);

async function resolveRuns(db, args) {
  if (args.run) {
    const r = await db.query('SELECT * FROM runs WHERE id = $1', [args.run]);
    return r.rows;
  }
  if (args.label) {
    const r = await db.query(
      'SELECT * FROM runs WHERE label = $1 ORDER BY id',
      [args.label],
    );
    return r.rows;
  }
  const r = await db.query('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  return r.rows;
}

async function analyzeRun(db, run) {
  const win = [run.started_at, run.ended_at];
  const metrics = { runId: run.id, label: run.label };

  // --- guard: clock sanity (split by side) ---------------------------------
  // A WSL2/Docker clock snap can hit one side and miss the other (telemetry is
  // dense, task transitions sparse), so grade task-side and vehicle-side
  // independently instead of nuking the whole run. id = insertion order = the
  // true causal order; occurred_at DECREASING as id increases means the clock
  // went backwards. (Order by id, NOT occurred_at — sorting by the suspect
  // column would hide the jump.)
  if (!run.ended_at) {
    metrics.taskReliable = metrics.vehicleReliable = false;
    metrics.warning = 'run still open (no ended_at)';
    return metrics;
  }
  const durS = (run.ended_at - run.started_at) / 1000;
  metrics.durationS = durS;
  if (durS <= 0) {
    metrics.taskReliable = metrics.vehicleReliable = false;
    metrics.warning = `inverted window (dur ${durS.toFixed(1)}s) — clock jumped mid-run`;
    return metrics;
  }
  const back = await db.query(
    `WITH v AS (
       SELECT occurred_at,
         LAG(occurred_at) OVER (PARTITION BY vehicle_name, session_id ORDER BY id) p
       FROM vehicle_state_transitions WHERE occurred_at BETWEEN $1 AND $2),
     t AS (
       SELECT occurred_at,
         LAG(occurred_at) OVER (PARTITION BY task_id ORDER BY id) p
       FROM task_status_transitions WHERE occurred_at BETWEEN $1 AND $2)
     SELECT (SELECT count(*) FROM v WHERE occurred_at < p) vc,
            (SELECT count(*) FROM t WHERE occurred_at < p) tc`,
    win,
  );
  const vc = Number(back.rows[0].vc);
  const tc = Number(back.rows[0].tc);
  metrics.taskReliable = tc === 0;
  metrics.vehicleReliable = vc === 0;
  if (tc > 0) metrics.taskWarning = `clock jumped: ${tc} task backward step(s)`;
  if (vc > 0)
    metrics.vehicleWarning = `clock jumped: ${vc} telemetry backward step(s)`;

  // --- task-side -----------------------------------------------------------
  const task = await db.query(
    `WITH tr AS (
       SELECT task_id, to_status, occurred_at, id,
         LEAD(occurred_at) OVER (PARTITION BY task_id ORDER BY occurred_at, id) nx
       FROM task_status_transitions
       WHERE occurred_at BETWEEN $1 AND $2),
     per_task AS (
       SELECT task_id,
         max(occurred_at) FILTER (WHERE to_status='DELIVERY_COMPLETED') done_at,
         min(occurred_at) FILTER (WHERE to_status='CREATED') created_at,
         COALESCE(sum(EXTRACT(epoch FROM nx-occurred_at))
                  FILTER (WHERE to_status='BLOCKED'), 0) blocked_s,
         COALESCE(sum(EXTRACT(epoch FROM nx-occurred_at))
                  FILTER (WHERE to_status='READY_TO_ASSIGN'), 0) assignwait_s
       FROM tr GROUP BY task_id)
     SELECT
       count(*) FILTER (WHERE done_at IS NOT NULL) n_done,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM done_at-created_at))
         FILTER (WHERE done_at IS NOT NULL) lat_median,
       percentile_cont(0.95) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM done_at-created_at))
         FILTER (WHERE done_at IS NOT NULL) lat_p95,
       max(EXTRACT(epoch FROM done_at-created_at))
         FILTER (WHERE done_at IS NOT NULL) lat_max,
       avg(assignwait_s) assignwait_avg,
       avg(blocked_s) blocked_avg
     FROM per_task`,
    win,
  );
  metrics.task = task.rows[0];

  // --- event counts + assignment quality -----------------------------------
  const ev = await db.query(
    `SELECT
       count(*) FILTER (WHERE to_status='BLOCKED') n_block,
       count(*) FILTER (WHERE to_status='FAILED') n_fail,
       count(*) FILTER (WHERE (context->>'preempted')='true') n_preempt,
       count(*) FILTER (WHERE to_status='PICKING_UP') n_assign,
       avg((context->>'distanceToSource')::float)
         FILTER (WHERE context->>'distanceToSource' IS NOT NULL) dist_avg,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY (context->>'distanceToSource')::float)
         FILTER (WHERE context->>'distanceToSource' IS NOT NULL) dist_median
     FROM task_status_transitions
     WHERE occurred_at BETWEEN $1 AND $2`,
    win,
  );
  metrics.events = ev.rows[0];

  // --- vehicle-side: interference f + utilization --------------------------
  const veh = await db.query(
    `WITH d AS (
       SELECT vehicle_name, proc_state, vehicle_state,
         EXTRACT(epoch FROM
           LEAD(occurred_at) OVER (PARTITION BY vehicle_name, session_id
                                   ORDER BY occurred_at, id) - occurred_at) dwell
       FROM vehicle_state_transitions
       WHERE occurred_at BETWEEN $1 AND $2)
     SELECT
       count(DISTINCT vehicle_name) n_veh,
       COALESCE(sum(dwell) FILTER (WHERE proc_state='PROCESSING_ORDER'), 0) working_s,
       COALESCE(sum(dwell) FILTER (
         WHERE proc_state='PROCESSING_ORDER' AND vehicle_state<>'EXECUTING'), 0) blocked_s,
       COALESCE(sum(dwell), 0) observed_s
     FROM d WHERE dwell IS NOT NULL`,
    win,
  );
  const v = veh.rows[0];
  metrics.vehicle = {
    n_veh: Number(v.n_veh),
    working_s: Number(v.working_s),
    blocked_s: Number(v.blocked_s),
    observed_s: Number(v.observed_s),
    f: Number(v.working_s) > 0 ? Number(v.blocked_s) / Number(v.working_s) : null,
    utilization:
      Number(v.observed_s) > 0
        ? Number(v.working_s) / Number(v.observed_s)
        : null,
  };
  return metrics;
}

function printRun(m) {
  console.log(`\n━━━ run #${m.runId}  "${m.label}" ━━━`);
  if (m.warning) {
    console.log(`  ⚠ ${m.warning}`);
    return;
  }
  const t = m.task, e = m.events, v = m.vehicle;
  console.log(`  window            ${m.durationS.toFixed(1)}s`);
  if (m.taskReliable) {
    const throughput = t.n_done > 0 ? (t.n_done / m.durationS) * 60 : 0;
    console.log(`  delivered         ${t.n_done}   (throughput ${n(throughput)}/min)`);
    console.log(`  latency  median   ${fmt(t.lat_median, 's')}   p95 ${fmt(t.lat_p95, 's')}   max ${fmt(t.lat_max, 's')}`);
    console.log(`  assign wait  avg  ${fmt(t.assignwait_avg, 's')}`);
    console.log(`  blocked time avg  ${fmt(t.blocked_avg, 's')}   (blocks ${e.n_block}, preempts ${e.n_preempt}, failed ${e.n_fail})`);
    console.log(`  dist→source       median ${fmt(e.dist_median)}   avg ${fmt(e.dist_avg)}   (assignments ${e.n_assign})`);
  } else {
    console.log(`  task-side         ⚠ ${m.taskWarning} — metrics dropped`);
  }
  if (m.vehicleReliable) {
    console.log(`  interference f    ${v.f == null ? '—' : (v.f * 100).toFixed(1) + '%'}   (blocked ${n(v.blocked_s)}s / working ${n(v.working_s)}s, ${v.n_veh} veh)`);
    console.log(`  utilization       ${v.utilization == null ? '—' : (v.utilization * 100).toFixed(1) + '%'}`);
  } else {
    console.log(`  vehicle-side      ⚠ ${m.vehicleWarning} — f/utilization dropped`);
  }
}

function printAggregate(runs) {
  // Grade each metric family by its own side's reliability.
  const taskOk = runs.filter((m) => m.taskReliable);
  const vehOk = runs.filter((m) => m.vehicleReliable);
  if (taskOk.length < 2 && vehOk.length < 2) return;
  const mean = (set, f) => {
    const xs = set.map(f).filter((x) => x != null).map(Number);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  console.log(`\n═══ aggregate (task-side ${taskOk.length} run(s), vehicle-side ${vehOk.length} run(s)) ═══`);
  console.log(`  delivered/run     ${fmt(mean(taskOk, (m) => Number(m.task.n_done)))}`);
  console.log(`  latency median    ${fmt(mean(taskOk, (m) => m.task.lat_median), 's')}`);
  console.log(`  assign wait avg   ${fmt(mean(taskOk, (m) => m.task.assignwait_avg), 's')}`);
  console.log(`  dist→source med   ${fmt(mean(taskOk, (m) => m.events.dist_median))}`);
  const f = mean(vehOk, (m) => m.vehicle.f);
  console.log(`  interference f    ${f == null ? '—' : (f * 100).toFixed(1) + '%'}`);
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const runs = await resolveRuns(db, args);
    if (runs.length === 0) {
      console.error('no matching runs');
      process.exit(1);
    }
    const results = [];
    for (const run of runs) results.push(await analyzeRun(db, run));

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      results.forEach(printRun);
      if (results.length > 1) printAggregate(results);
    }
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
