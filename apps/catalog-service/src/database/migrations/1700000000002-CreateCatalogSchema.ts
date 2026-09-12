import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogSchema1700000000002 implements MigrationInterface {
  name = 'CreateCatalogSchema1700000000002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE TABLE movies (
        id uuid PRIMARY KEY,
        title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
        origin_title text NULL,
        description text NULL,
        poster_url text NULL,
        backdrop_url text NULL,
        release_year integer NULL CHECK (release_year IS NULL OR release_year BETWEEN 1800 AND 2200),
        type text NOT NULL CHECK (type IN ('movie','series')),
        content_kind text NOT NULL CHECK (content_kind IN ('film','animation','show')),
        status text NOT NULL CHECK (status IN ('draft','published','archived')),
        access_tier text NOT NULL DEFAULT 'free' CHECK (access_tier IN ('free','subscription')),
        is_kids_safe boolean NOT NULL DEFAULT false,
        average_rating numeric(3,1) NOT NULL DEFAULT 0 CHECK (average_rating BETWEEN 0 AND 10),
        published_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_movies_public_page ON movies (published_at DESC, id) WHERE status='published'`);
    await queryRunner.query(`CREATE INDEX idx_movies_title_search ON movies USING gin (title gin_trgm_ops)`);
    await queryRunner.query(`CREATE TABLE genres (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL)`);
    await queryRunner.query(`CREATE TABLE countries (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL)`);
    await queryRunner.query(`CREATE TABLE movie_genres (movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE, genre_id uuid NOT NULL REFERENCES genres(id) ON DELETE RESTRICT, PRIMARY KEY(movie_id,genre_id))`);
    await queryRunner.query(`CREATE TABLE movie_countries (movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE, country_id uuid NOT NULL REFERENCES countries(id) ON DELETE RESTRICT, PRIMARY KEY(movie_id,country_id))`);
    await queryRunner.query(`
      CREATE TABLE seasons (
        id uuid PRIMARY KEY, movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        season_number integer NOT NULL CHECK (season_number > 0), is_synthetic boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(movie_id,season_number), UNIQUE(id,movie_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE playable_items (
        id uuid PRIMARY KEY, movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('movie','episode')), season_id uuid NULL,
        episode_number integer NULL CHECK (episode_number IS NULL OR episode_number > 0),
        label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200), sort_order integer NOT NULL,
        duration_seconds integer NULL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
        archived_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(id,movie_id),
        CONSTRAINT fk_playable_season_movie FOREIGN KEY(season_id,movie_id) REFERENCES seasons(id,movie_id),
        CONSTRAINT ck_playable_shape CHECK ((kind='movie' AND season_id IS NULL AND episode_number IS NULL) OR (kind='episode' AND season_id IS NOT NULL))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_playable_movie_single ON playable_items(movie_id) WHERE kind='movie'`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_playable_episode_number ON playable_items(season_id,episode_number) WHERE episode_number IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX idx_playable_movie_order ON playable_items(movie_id,sort_order,id) WHERE archived_at IS NULL`);
    await queryRunner.query(`
      CREATE TABLE content_sources (
        id uuid PRIMARY KEY, movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        source_type text NOT NULL CHECK (source_type IN ('owned','third_party')),
        provider text NULL, external_id text NULL, external_slug text NULL, external_updated_at timestamptz NULL,
        metadata_locked boolean NOT NULL DEFAULT false,
        source_status text NOT NULL DEFAULT 'unknown' CHECK (source_status IN ('unknown','available','unavailable','error')),
        metadata_checked_at timestamptz NULL, version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(id,movie_id),
        CONSTRAINT ck_content_source_identity CHECK (
          (source_type='owned' AND provider IS NULL AND external_id IS NULL AND external_slug IS NULL)
          OR (source_type='third_party' AND provider IS NOT NULL AND external_id IS NOT NULL AND external_slug IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_content_source_provider_external_id ON content_sources(provider,external_id) WHERE provider IS NOT NULL AND external_id IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_content_source_provider_slug ON content_sources(provider,external_slug) WHERE provider IS NOT NULL AND external_slug IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX idx_content_sources_movie ON content_sources(movie_id,source_type)`);
    await queryRunner.query(`
      CREATE TABLE source_items (
        id uuid PRIMARY KEY, movie_id uuid NOT NULL, source_id uuid NOT NULL, playable_id uuid NOT NULL,
        server_key text NOT NULL CHECK(length(btrim(server_key)) > 0), server_label text NOT NULL,
        external_episode_key text NULL, external_episode_slug text NULL,
        playback_mode text NOT NULL CHECK(playback_mode IN ('owned_hls','external_hls','external_embed','metadata_only')),
        source_status text NOT NULL DEFAULT 'unknown' CHECK(source_status IN ('unknown','available','unavailable','error')),
        last_resolved_at timestamptz NULL, retry_after timestamptz NULL, version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(source_id,movie_id) REFERENCES content_sources(id,movie_id) ON DELETE CASCADE,
        FOREIGN KEY(playable_id,movie_id) REFERENCES playable_items(id,movie_id) ON DELETE CASCADE,
        CONSTRAINT ck_owned_selector CHECK (playback_mode NOT IN ('owned_hls') OR external_episode_key IS NULL)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_source_item_server_playable ON source_items(source_id,playable_id,server_key)`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_source_item_external_selector ON source_items(source_id,server_key,external_episode_key) WHERE external_episode_key IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX idx_source_items_playable ON source_items(movie_id,playable_id,source_status)`);
    await queryRunner.query(`
      CREATE TABLE sync_runs (
        id uuid PRIMARY KEY, provider text NOT NULL CHECK(provider='kkphim'), mode text NOT NULL CHECK(mode IN ('discovery','refresh','import')),
        status text NOT NULL CHECK(status IN ('queued','running','completed','partial','failed')),
        requested_by uuid NULL, parameters jsonb NOT NULL DEFAULT '{}'::jsonb, checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_count integer NOT NULL DEFAULT 0 CHECK(created_count>=0), updated_count integer NOT NULL DEFAULT 0 CHECK(updated_count>=0),
        error_count integer NOT NULL DEFAULT 0 CHECK(error_count>=0), last_error_code text NULL,
        created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NULL, finished_at timestamptz NULL,
        lease_until timestamptz NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_sync_runs_claim ON sync_runs(created_at,id) WHERE status='queued'`);
    await queryRunner.query(`CREATE TABLE catalog_audit_logs (id uuid PRIMARY KEY, actor_id uuid NULL, action text NOT NULL, movie_id uuid NOT NULL, source_item_id uuid NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL, request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        event_id uuid PRIMARY KEY, event_type text NOT NULL CHECK(event_type IN ('movie.published','movie.updated','movie.archived','movie.source.updated')),
        aggregate_id uuid NOT NULL, aggregate_version bigint NOT NULL CHECK(aggregate_version>0), occurred_at timestamptz NOT NULL,
        available_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz NULL, published_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error text NULL, envelope jsonb NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_catalog_outbox_pending ON outbox_events(available_at,occurred_at) WHERE published_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS catalog_audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS sync_runs');
    await queryRunner.query('DROP TABLE IF EXISTS source_items');
    await queryRunner.query('DROP TABLE IF EXISTS content_sources');
    await queryRunner.query('DROP TABLE IF EXISTS playable_items');
    await queryRunner.query('DROP TABLE IF EXISTS seasons');
    await queryRunner.query('DROP TABLE IF EXISTS movie_countries');
    await queryRunner.query('DROP TABLE IF EXISTS movie_genres');
    await queryRunner.query('DROP TABLE IF EXISTS countries');
    await queryRunner.query('DROP TABLE IF EXISTS genres');
    await queryRunner.query('DROP TABLE IF EXISTS movies');
  }
}
