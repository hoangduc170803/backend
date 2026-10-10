/**
 * Serialise the kernel's plant-model JSON (`GET /v1/plantModel`) back to the flat openTCS
 * plant-model XML that `map-loader/opentcs-xml.parser.ts` reads on upload — so a downloaded
 * map re-uploads without conversion. Layout/peripheral data the parser ignores is dropped;
 * the kernel regenerates layout on the next PUT.
 */

type Rec = Record<string, unknown>;
const textValue = (value: unknown): string => String(value);

const recArray = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];

function esc(v: unknown): string {
  return textValue(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intAttr(v: unknown): string {
  const n = Number(v);
  return String(Number.isFinite(n) ? Math.round(n) : 0);
}

function xyz(o: Rec): { x: unknown; y: unknown; z: unknown } {
  const pose = o.pose as Rec | undefined;
  const p = (o.position ?? pose?.position ?? {}) as Rec;
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 };
}

function propXml(list: unknown, indent: string): string[] {
  return recArray(list).map(
    (p) =>
      `${indent}<property name="${esc(p.name ?? p.key)}" value="${esc(p.value)}"/>`,
  );
}

function el(tag: string, attrs: string, children: string[]): string {
  if (children.length === 0) return `  <${tag} ${attrs}/>`;
  return `  <${tag} ${attrs}>\n${children.join('\n')}\n  </${tag}>`;
}

export function plantModelToXml(raw: unknown): string {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<model name="${esc(m.name ?? 'unnamed')}">`);

  for (const p of recArray(m.points)) {
    const { x, y, z } = xyz(p);
    const angle = Number(p.vehicleOrientationAngle);
    const attrs =
      `name="${esc(p.name)}" positionX="${intAttr(x)}" positionY="${intAttr(y)}" ` +
      `positionZ="${intAttr(z)}" ` +
      (Number.isFinite(angle) ? `vehicleOrientationAngle="${angle}" ` : '') +
      `type="${esc(p.type ?? 'HALT_POSITION')}"`;
    lines.push(el('point', attrs, propXml(p.properties, '    ')));
  }

  for (const pa of recArray(m.paths)) {
    const src = esc(pa.srcPointName ?? pa.sourcePoint);
    const dest = esc(pa.destPointName ?? pa.destinationPoint);
    const name =
      typeof pa.name === 'string' && pa.name.trim() !== ''
        ? esc(pa.name)
        : `${src} --- ${dest}`;
    const attrs =
      `name="${name}" sourcePoint="${src}" ` +
      `destinationPoint="${dest}" ` +
      `length="${intAttr(pa.length)}" maxVelocity="${intAttr(pa.maxVelocity)}" ` +
      `maxReverseVelocity="${intAttr(pa.maxReverseVelocity)}" locked="${pa.locked === true}"`;
    lines.push(el('path', attrs, propXml(pa.properties, '    ')));
  }

  for (const v of recArray(m.vehicles)) {
    const attrs =
      `name="${esc(v.name)}" maxVelocity="${intAttr(v.maxVelocity)}" ` +
      `maxReverseVelocity="${intAttr(v.maxReverseVelocity)}" ` +
      `energyLevelCritical="${intAttr(v.energyLevelCritical)}" ` +
      `energyLevelGood="${intAttr(v.energyLevelGood)}" ` +
      `energyLevelFullyRecharged="${intAttr(v.energyLevelFullyRecharged)}" ` +
      `energyLevelSufficientlyRecharged="${intAttr(v.energyLevelSufficientlyRecharged)}"`;
    lines.push(el('vehicle', attrs, propXml(v.properties, '    ')));
  }

  for (const lt of recArray(m.locationTypes)) {
    const children = [
      ...strArray(lt.allowedOperations).map(
        (op) => `    <allowedOperation name="${esc(op)}"/>`,
      ),
      ...propXml(lt.properties, '    '),
    ];
    lines.push(el('locationType', `name="${esc(lt.name)}"`, children));
  }

  for (const loc of recArray(m.locations)) {
    const { x, y, z } = xyz(loc);
    const links = recArray(loc.links);
    const linkXml = (
      links.length > 0
        ? links.map((l) => textValue(l.pointName ?? l.point ?? ''))
        : loc.links && typeof loc.links === 'object'
          ? Object.keys(loc.links as Rec)
          : []
    )
      .filter(Boolean)
      .map((pt) => `    <link point="${esc(pt)}"/>`);
    const attrs =
      `name="${esc(loc.name)}" type="${esc(loc.typeName ?? loc.type)}" ` +
      `positionX="${intAttr(x)}" positionY="${intAttr(y)}" positionZ="${intAttr(z)}"`;
    lines.push(
      el('location', attrs, [...linkXml, ...propXml(loc.properties, '    ')]),
    );
  }

  for (const b of recArray(m.blocks)) {
    const members = strArray(b.members).length
      ? strArray(b.members)
      : recArray(b.members).map((mem) => textValue(mem.name ?? ''));
    const children = members
      .filter(Boolean)
      .map((name) => `    <member name="${esc(name)}"/>`);
    lines.push(
      el(
        'block',
        `name="${esc(b.name)}" type="${esc(b.type ?? 'SINGLE_VEHICLE_ONLY')}"`,
        children,
      ),
    );
  }

  const vl = (m.visualLayout ?? recArray(m.visualLayouts)[0] ?? {}) as Rec;
  const vlChildren = [
    ...recArray(vl.layers).map(
      (ly) =>
        `    <layer id="${intAttr(ly.id)}" ordinal="${intAttr(ly.ordinal)}" ` +
        `visible="${ly.visible !== false}" name="${esc(ly.name ?? 'Layer')}" ` +
        `groupId="${intAttr(ly.groupId)}"/>`,
    ),
    ...recArray(vl.layerGroups).map(
      (g) =>
        `    <layerGroup id="${intAttr(g.id)}" name="${esc(g.name ?? 'Group')}" ` +
        `visible="${g.visible !== false}"/>`,
    ),
    ...propXml(vl.properties, '    '),
  ];
  const vlAttrs = `name="${esc(vl.name ?? 'VLayout')}" scaleX="${textValue(vl.scaleX ?? 50)}" scaleY="${textValue(vl.scaleY ?? 50)}"`;
  lines.push(
    vlChildren.length === 0
      ? `  <visualLayout ${vlAttrs}/>`
      : el('visualLayout', vlAttrs, vlChildren),
  );

  lines.push('</model>');
  return lines.join('\n') + '\n';
}
