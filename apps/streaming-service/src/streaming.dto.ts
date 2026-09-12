import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Matches, Min } from 'class-validator';

export class CreatePlaybackSessionDto {
  @IsUUID() movieId!: string;
  @IsUUID() playableId!: string;
  @IsUUID() sourceItemId!: string;
  @IsUUID() profileId!: string;
}

export class PlaybackProgressDto {
  @IsString() @Matches(/^\d{1,19}$/) seq!: string;
  @IsInt() @Min(0) @Max(86_400) positionSeconds!: number;
  @IsOptional() @IsInt() @Min(1) @Max(86_400) durationSeconds?: number | null;
}

export class PlaybackEventDto {
  @IsUUID() eventId!: string;
  @IsIn(['started', 'qualified', 'failed', 'stopped']) type!: 'started' | 'qualified' | 'failed' | 'stopped';
  @IsOptional() @IsInt() @Min(0) @Max(86_400) playedSeconds?: number;
  @IsOptional() @IsString() @MaxLength(80) reasonCode?: string;
}

export class InitiateUploadDto {
  @IsUUID() sourceItemId!: string;
  @IsInt() @Min(1) @Max(10 * 1024 * 1024 * 1024) sizeBytes!: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) checksumSha256!: string;
}

export class TranscodeProcessingDto {
  @IsInt() @Min(1) generation!: number;
  @IsInt() @Min(1) attempt!: number;
  @IsUUID() attemptToken!: string;
}

export class TranscodeCompletedDto extends TranscodeProcessingDto {
  @IsString() @Matches(/^assets\/[0-9a-f-]{36}\/g\d+\/a\d+\/master\.m3u8$/i) manifestKey!: string;
  @IsInt() @Min(1) @Max(86_400) durationSeconds!: number;
  @IsString({ each: true }) @IsIn(['480p', '720p', '1080p'], { each: true }) resolutions!: string[];
}

export class TranscodeFailedDto extends TranscodeProcessingDto {
  @IsString() @MaxLength(80) errorCode!: string;
}
