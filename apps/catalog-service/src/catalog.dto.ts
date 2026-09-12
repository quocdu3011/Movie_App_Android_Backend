import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CatalogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(120) genre?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1800) @Max(2200) year?: number;
  @IsOptional() @IsIn(['movie', 'series']) type?: 'movie' | 'series';
  @IsOptional() @IsIn(['film', 'animation', 'show']) contentKind?: 'film' | 'animation' | 'show';
  @IsOptional() @IsIn(['owned', 'third_party']) sourceType?: 'owned' | 'third_party';
  @IsOptional() @IsString() @MaxLength(80) provider?: string;
  @IsOptional() @IsIn(['newest', 'rating', 'title']) sort?: 'newest' | 'rating' | 'title';
  @IsOptional() @IsUUID() profileId?: string;
}

export class SearchProviderQueryDto {
  @IsString() @MinLength(1) @MaxLength(100) keyword!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
}

export class ImportProviderDto {
  @IsString() @MinLength(1) @MaxLength(180) slug!: string;
  @IsOptional() @IsUUID() movieId?: string;
}

export class SyncProviderDto {
  @IsOptional() @IsIn(['discovery', 'refresh']) mode: 'discovery' | 'refresh' = 'discovery';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) maxPages = 1;
}

export class CreateMovieDto {
  @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @IsIn(['movie', 'series']) type!: 'movie' | 'series';
  @IsOptional() @IsIn(['film', 'animation', 'show']) contentKind?: 'film' | 'animation' | 'show';
  @IsOptional() @IsString() @MaxLength(300) originTitle?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsString() @MaxLength(2000) posterUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) backdropUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1800) @Max(2200) releaseYear?: number;
  @IsOptional() @IsIn(['free', 'subscription']) accessTier?: 'free' | 'subscription';
  @IsOptional() @IsBoolean() isKidsSafe?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(10) averageRating?: number;
}

export class PatchMovieDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(300) originTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) posterUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) backdropUrl?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1800) @Max(2200) releaseYear?: number | null;
  @IsOptional() @IsIn(['film', 'animation', 'show']) contentKind?: 'film' | 'animation' | 'show';
  @IsOptional() @IsIn(['free', 'subscription']) accessTier?: 'free' | 'subscription';
  @IsOptional() @IsBoolean() isKidsSafe?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(10) averageRating?: number;
}

export class CreateSeasonDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) seasonNumber!: number;
  @IsOptional() @IsBoolean() isSynthetic?: boolean;
}

export class CreatePlayableDto {
  @IsIn(['movie', 'episode']) kind!: 'movie' | 'episode';
  @IsOptional() @IsUUID() seasonId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) episodeNumber?: number;
  @IsString() @MinLength(1) @MaxLength(200) label!: string;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) durationSeconds?: number;
}

export class CreateContentSourceDto {
  @IsIn(['owned', 'third_party']) sourceType!: 'owned' | 'third_party';
  @IsOptional() @IsString() @MaxLength(80) provider?: string;
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsString() @MaxLength(200) externalSlug?: string;
  @IsOptional() @IsBoolean() metadataLocked?: boolean;
}

export class CreateSourceItemDto {
  @IsUUID() playableId!: string;
  @IsString() @MinLength(1) @MaxLength(100) serverKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) serverLabel!: string;
  @IsOptional() @IsString() @MaxLength(200) externalEpisodeKey?: string;
  @IsOptional() @IsString() @MaxLength(200) externalEpisodeSlug?: string;
  @IsIn(['owned_hls', 'external_hls', 'external_embed', 'metadata_only']) playbackMode!: string;
  @IsOptional() @IsIn(['unknown', 'available', 'unavailable', 'error']) sourceStatus?: string;
}

export class PatchSourceItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) serverKey?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) serverLabel?: string;
  @IsOptional() @IsString() @MaxLength(200) externalEpisodeKey?: string | null;
  @IsOptional() @IsString() @MaxLength(200) externalEpisodeSlug?: string | null;
  @IsOptional() @IsUUID() playableId?: string;
}

export class SourceItemStatusDto {
  @IsIn(['available', 'unavailable', 'error']) status!: 'available' | 'unavailable' | 'error';
  @IsOptional() @IsISO8601() retryAfter?: string | null;
}

export class MetadataLockDto { @IsBoolean() locked!: boolean; }
