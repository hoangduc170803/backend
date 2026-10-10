import { XMLParser } from 'fast-xml-parser';

// ─── Public DTOs ────────────────────────────────────────────────────────────

export interface PlantModelDto {
  name: string;
  points: PointDto[];
  paths: PathDto[];
  vehicles: VehicleDto[];
  locationTypes: LocationTypeDto[];
  locations: LocationDto[];
  blocks: BlockDto[];
  visualLayout: VisualLayoutDto;
}

export interface PointDto {
  name: string;
  position: { x: number; y: number; z: number };
  type: string;
  vehicleOrientationAngle?: number;
  properties: PropertyDto[];
}

export interface PathDto {
  name: string;
  srcPointName: string;
  destPointName: string;
  length: number;
  maxVelocity: number;
  maxReverseVelocity: number;
  locked: boolean;
  properties: PropertyDto[];
}

export interface PropertyDto {
  name: string;
  value: string;
}

export interface VehicleDto {
  name: string;
  maxVelocity: number;
  maxReverseVelocity: number;
  energyLevelCritical: number;
  energyLevelGood: number;
  energyLevelFullyRecharged: number;
  energyLevelSufficientlyRecharged: number;
  properties: PropertyDto[];
}

export interface LocationTypeDto {
  name: string;
  allowedOperations: string[];
  properties: PropertyDto[];
}

export interface LocationDto {
  name: string;
  typeName: string;
  position: { x: number; y: number; z: number };
  links: { pointName: string }[];
  properties: PropertyDto[];
}

export interface BlockDto {
  name: string;
  type: string;
  memberNames: string[];
}

export interface VisualLayoutDto {
  name: string;
  scaleX: number;
  scaleY: number;
  layers: LayerDto[];
  layerGroups: LayerGroupDto[];
  properties: PropertyDto[];
}

export interface LayerDto {
  id: number;
  ordinal: number;
  visible: boolean;
  name: string;
  groupId: number;
}

export interface LayerGroupDto {
  id: number;
  name: string;
  visible: boolean;
}

// ─── Raw XML interfaces (output of fast-xml-parser) ─────────────────────────

interface RawPoint {
  '@_name': string;
  '@_positionX': string;
  '@_positionY': string;
  '@_positionZ': string;
  '@_vehicleOrientationAngle': string;
  '@_type': string;
  property?: RawProperty[];
}

interface RawPath {
  '@_name': string;
  '@_sourcePoint': string;
  '@_destinationPoint': string;
  '@_length': string;
  '@_maxVelocity': string;
  '@_maxReverseVelocity': string;
  '@_locked': string;
  property?: RawProperty[];
}

interface RawProperty {
  '@_name': string;
  '@_value': string;
}

interface RawVehicle {
  '@_name': string;
  '@_maxVelocity': string;
  '@_maxReverseVelocity': string;
  '@_energyLevelCritical': string;
  '@_energyLevelGood': string;
  '@_energyLevelFullyRecharged': string;
  '@_energyLevelSufficientlyRecharged': string;
  property?: RawProperty[];
}

interface RawAllowedOperation {
  '@_name': string;
}

interface RawLocationType {
  '@_name': string;
  allowedOperation?: RawAllowedOperation[];
  property?: RawProperty[];
}

interface RawLink {
  '@_point': string;
}

interface RawLocation {
  '@_name': string;
  '@_type': string;
  '@_positionX': string;
  '@_positionY': string;
  '@_positionZ': string;
  link?: RawLink[];
  property?: RawProperty[];
}

interface RawMember {
  '@_name': string;
}

interface RawBlock {
  '@_name': string;
  '@_type': string;
  member?: RawMember[];
}

interface RawLayer {
  '@_id': string;
  '@_ordinal': string;
  '@_visible': string;
  '@_name': string;
  '@_groupId': string;
}

interface RawLayerGroup {
  '@_id': string;
  '@_name': string;
  '@_visible': string;
}

interface RawVisualLayout {
  '@_name': string;
  '@_scaleX': string;
  '@_scaleY': string;
  layer?: RawLayer[];
  layerGroup?: RawLayerGroup[];
  property?: RawProperty[];
}

interface RawModel {
  '@_name': string;
  point?: RawPoint[];
  path?: RawPath[];
  vehicle?: RawVehicle[];
  locationType?: RawLocationType[];
  location?: RawLocation[];
  block?: RawBlock[];
  visualLayout: RawVisualLayout;
}

interface RawParsed {
  model: RawModel;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const ARRAY_TAGS = new Set([
  'point',
  'path',
  'vehicle',
  'locationType',
  'location',
  'outgoingPath',
  'allowedOperation',
  'link',
  'layer',
  'layerGroup',
  'block',
  'member',
  'property',
]);

function toProperties(raw: RawProperty[] | undefined): PropertyDto[] {
  return (raw ?? []).map((p) => ({ name: p['@_name'], value: p['@_value'] }));
}

export function parseOpenTcsXml(xmlContent: string): PlantModelDto {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ARRAY_TAGS.has(name),
  });

  const { model } = parser.parse(xmlContent) as RawParsed;

  const points: PointDto[] = (model.point ?? []).map((p) => {
    const angle = parseFloat(p['@_vehicleOrientationAngle']);
    const point: PointDto = {
      name: p['@_name'],
      position: {
        x: parseInt(p['@_positionX']),
        y: parseInt(p['@_positionY']),
        z: parseInt(p['@_positionZ']),
      },
      type: p['@_type'],
      properties: toProperties(p.property),
    };
    if (!isNaN(angle)) {
      point.vehicleOrientationAngle = angle;
    }
    return point;
  });

  const paths: PathDto[] = (model.path ?? []).map((p) => ({
    name: p['@_name'],
    srcPointName: p['@_sourcePoint'],
    destPointName: p['@_destinationPoint'],
    length: parseInt(p['@_length']),
    maxVelocity: parseInt(p['@_maxVelocity']),
    maxReverseVelocity: parseInt(p['@_maxReverseVelocity']),
    locked: p['@_locked'] === 'true',
    properties: toProperties(p.property),
  }));

  const vehicles: VehicleDto[] = (model.vehicle ?? []).map((v) => ({
    name: v['@_name'],
    maxVelocity: parseInt(v['@_maxVelocity']),
    maxReverseVelocity: parseInt(v['@_maxReverseVelocity']),
    energyLevelCritical: parseInt(v['@_energyLevelCritical']),
    energyLevelGood: parseInt(v['@_energyLevelGood']),
    energyLevelFullyRecharged: parseInt(v['@_energyLevelFullyRecharged']),
    energyLevelSufficientlyRecharged: parseInt(
      v['@_energyLevelSufficientlyRecharged'],
    ),
    properties: toProperties(v.property),
  }));

  const locationTypes: LocationTypeDto[] = (model.locationType ?? []).map(
    (lt) => ({
      name: lt['@_name'],
      allowedOperations: (lt.allowedOperation ?? []).map((op) => op['@_name']),
      properties: toProperties(lt.property),
    }),
  );

  const locations: LocationDto[] = (model.location ?? []).map((l) => ({
    name: l['@_name'],
    typeName: l['@_type'],
    position: {
      x: parseInt(l['@_positionX']),
      y: parseInt(l['@_positionY']),
      z: parseInt(l['@_positionZ']),
    },
    links: (l.link ?? []).map((link) => ({ pointName: link['@_point'] })),
    properties: toProperties(l.property),
  }));

  const blocks: BlockDto[] = (model.block ?? []).map((b) => ({
    name: b['@_name'],
    type: b['@_type'],
    memberNames: (b.member ?? []).map((mem) => mem['@_name']),
  }));

  const vl = model.visualLayout;
  const visualLayout: VisualLayoutDto = {
    name: vl['@_name'],
    scaleX: parseFloat(vl['@_scaleX']),
    scaleY: parseFloat(vl['@_scaleY']),
    layers: (vl.layer ?? []).map((layer) => ({
      id: parseInt(layer['@_id']),
      ordinal: parseInt(layer['@_ordinal']),
      visible: layer['@_visible'] === 'true',
      name: layer['@_name'],
      groupId: parseInt(layer['@_groupId']),
    })),
    layerGroups: (vl.layerGroup ?? []).map((lg) => ({
      id: parseInt(lg['@_id']),
      name: lg['@_name'],
      visible: lg['@_visible'] === 'true',
    })),
    properties: toProperties(vl.property),
  };

  return {
    name: model['@_name'],
    points,
    paths,
    vehicles,
    locationTypes,
    locations,
    blocks,
    visualLayout,
  };
}
