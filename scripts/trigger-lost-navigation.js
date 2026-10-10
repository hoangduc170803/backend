/* eslint-disable */
// @ts-nocheck
'use strict';

const {
  loadEnv,
  config,
  simulationTopic,
  connect,
  publish,
  readLatest,
  arg,
} = require('./lib/sim-mqtt');

const ERROR_TYPE = 'adapterLostNavigation';
const DEFAULT_VEHICLE = 'V01';
const DEFAULT_NODE = '0014';
const DEFAULT_X_MM = 36000;
const DEFAULT_Y_MM = 0;
const DEFAULT_MAP_ID = 'F1';
const MM_PER_METER = 1000;

const USAGE = `Inject an ${ERROR_TYPE} FATAL error into a simulated AGV (AgvSimulator) over MQTT.

The sim teleports itself onto the given node, drops its speed to zero and reports
the error at ErrorLevel FATAL, which is what the kernel sees as a lost-navigation
vehicle. Undo it with scripts/clear-vehicle-errors.js.

  node scripts/trigger-lost-navigation.js [options]

Options (defaults are vehicle 1 standing on point ${DEFAULT_NODE}):
  --vehicle <serial>  VDA5050 serialNumber, default ${DEFAULT_VEHICLE} (= Vehicle-0001 in maps/v7-vda5050.xml)
  --node <name>       openTCS point name, default ${DEFAULT_NODE}
  --x <mm>            point positionX in millimetres, default ${DEFAULT_X_MM}
  --y <mm>            point positionY in millimetres, default ${DEFAULT_Y_MM}
  --map <id>          VDA5050 mapId, default ${DEFAULT_MAP_ID}
  --theta <rad>       body heading in radians; omitted means "keep current heading"
  --host <host>       broker host, default localhost
  --port <port>       broker port, default 1883
  --no-verify         skip reading the sim status topic back

--x/--y take millimetres so they can be copied straight out of the plant model
XML (<point positionX=.../>); they are published as metres, which is what
VDA5050 nodePosition and the simulator's own distance model expect.

Env (all optional):
  MQTT_URL                 overrides --host/--port entirely, e.g. mqtt://10.0.0.5:1883
  MQTT_USER                default fms
  MQTT_PASS                default Aubot@2025
  VDA5050_MANUFACTURER     default AUBOT
  VDA5050_INTERFACE_NAME   default aubotagv
  VERIFY_MS                status read-back window, default 2500

Requires the mqtt package (already a devDependency of this repo; run
\`pnpm install\` in wes/ if node cannot resolve it).

Examples:
  node scripts/trigger-lost-navigation.js
  node scripts/trigger-lost-navigation.js --vehicle V07 --node 0090 --x 45000 --y -1000
  node scripts/trigger-lost-navigation.js --host 171.244.5.185 --port 1883`;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const theta = arg(args, 'theta', null);
  return {
    help: false,
    vehicle: arg(args, 'vehicle', DEFAULT_VEHICLE),
    node: arg(args, 'node', DEFAULT_NODE),
    xMm: Number(arg(args, 'x', DEFAULT_X_MM)),
    yMm: Number(arg(args, 'y', DEFAULT_Y_MM)),
    mapId: arg(args, 'map', DEFAULT_MAP_ID),
    theta: theta === null ? null : Number(theta),
    host: arg(args, 'host', 'localhost'),
    port: arg(args, 'port', '1883'),
    verify: !args.includes('--no-verify'),
  };
}

function validate(opts) {
  if (!opts.vehicle) throw new Error('--vehicle must not be empty');
  if (!opts.node) throw new Error('--node must not be empty');
  if (!Number.isFinite(opts.xMm)) throw new Error(`--x must be a number, got: ${opts.xMm}`);
  if (!Number.isFinite(opts.yMm)) throw new Error(`--y must be a number, got: ${opts.yMm}`);
  if (opts.theta !== null && !Number.isFinite(opts.theta)) {
    throw new Error(`--theta must be a number in radians, got: ${opts.theta}`);
  }
}

function controlPayload(opts) {
  const payload = {
    command: 'triggerError',
    errorType: ERROR_TYPE,
    targetNodeId: opts.node,
    x: opts.xMm / MM_PER_METER,
    y: opts.yMm / MM_PER_METER,
    mapId: opts.mapId,
  };
  if (opts.theta !== null) payload.theta = opts.theta;
  return payload;
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  validate(opts);

  const cfg = config({ host: opts.host, port: opts.port });
  const topic = simulationTopic(cfg, opts.vehicle, 'control');
  const encoded = JSON.stringify(controlPayload(opts));

  const client = await connect(cfg, 'lost-nav');
  try {
    await publish(client, topic, encoded, 1);
    console.log(`broker  ${cfg.url}`);
    console.log(`topic   ${topic}`);
    console.log(`payload ${encoded}`);
    console.log(
      `sent    ${ERROR_TYPE} on ${opts.vehicle} at ${opts.node} (${opts.xMm}, ${opts.yMm}) mm`,
    );

    if (!opts.verify) return;
    const status = await readLatest(
      client,
      simulationTopic(cfg, opts.vehicle, 'status'),
      cfg.verifyMs,
    );
    if (!status) {
      throw new Error(
        `no simulation status from ${opts.vehicle} — is the AgvSimulator running and connected to ${cfg.url}?`,
      );
    }
    console.log(`status  activeError=${status.activeError} laserActive=${status.laserActive}`);
    if (status.activeError !== ERROR_TYPE) {
      throw new Error(
        `${opts.vehicle} reports activeError=${status.activeError}, expected ${ERROR_TYPE}`,
      );
    }
  } finally {
    client.end(true);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
