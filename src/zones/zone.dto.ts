import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ZoneEntity, ZoneStatus, ZoneType } from './entities/zone.entity';

/** #RGB, #RRGGBB or #RRGGBBAA hex color. */
export const HEX_COLOR_REGEX =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export class ZoneMemberDto {
  @IsString()
  @IsNotEmpty()
  locationName!: string;

  @IsInt()
  @Min(0)
  positionIndex!: number;
}

export class CreateZoneDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEnum(ZoneType)
  type!: ZoneType;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX, {
    message: 'color phải là mã hex hợp lệ (#RRGGBB).',
  })
  color?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  operation?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxVehicles?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ZoneMemberDto)
  members!: ZoneMemberDto[];
}

export class AssignZoneMapDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  zoneIds!: string[];
}

export class ListZonesQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  allMaps?: boolean;
}

export class UpdateZoneDto {
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX, {
    message: 'color phải là mã hex hợp lệ (#RRGGBB).',
  })
  color?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  operation?: string;

  /** `null` explicitly clears a previously-set cap; `undefined` leaves it unchanged. */
  @ValidateIf((o: UpdateZoneDto) => o.maxVehicles != null)
  @IsInt()
  @Min(1)
  maxVehicles?: number | null;
}

export interface ZoneMemberResponse {
  locationName: string;
  positionIndex: number;
}

export interface ZoneResponse {
  id: string;
  name: string;
  type: ZoneType;
  status: ZoneStatus;
  color: string | null;
  operation: string | null;
  maxVehicles: number | null;
  plantModelName: string | null;
  mapRecordId: string | null;
  createdAt: Date;
  members: ZoneMemberResponse[];
}

export interface ZoneListItemResponse extends ZoneResponse {
  occupiedSlotCount: number;
  totalSlotCount: number;
}

export function toZoneResponse(zone: ZoneEntity): ZoneResponse {
  return {
    id: zone.id,
    name: zone.name,
    type: zone.type,
    status: zone.status,
    color: zone.color,
    operation: zone.operation,
    maxVehicles: zone.maxVehicles,
    plantModelName: zone.plantModelName,
    mapRecordId: zone.mapRecordId,
    createdAt: zone.createdAt,
    members: [...zone.members]
      .sort((a, b) => a.positionIndex - b.positionIndex)
      .map((member) => ({
        locationName: member.locationName,
        positionIndex: member.positionIndex,
      })),
  };
}
