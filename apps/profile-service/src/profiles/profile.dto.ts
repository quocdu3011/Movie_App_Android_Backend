import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateProfileDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  avatarId?: number | null;

  @IsOptional()
  @IsBoolean()
  isKids?: boolean;
}

export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32767)
  avatarId?: number | null;

  @IsOptional()
  @IsBoolean()
  isKids?: boolean;
}

export class ValidateProfileDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  profileId!: string;
}
