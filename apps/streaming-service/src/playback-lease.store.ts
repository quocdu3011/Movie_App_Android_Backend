import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { STREAMING_CONFIG, StreamingConfig } from './streaming.config';

const RESERVE_SCRIPT = `
  local key=KEYS[1]
  local session=ARGV[1]
  local now=tonumber(ARGV[2])
  local expires=tonumber(ARGV[3])
  local limit=tonumber(ARGV[4])
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
  local existing=redis.call('ZSCORE',key,session)
  if existing then
    redis.call('ZADD',key,expires,session)
    redis.call('PEXPIRE',key,math.max(expires-now+60000,60000))
    return 2
  end
  if redis.call('ZCARD',key) >= limit then return 0 end
  redis.call('ZADD',key,expires,session)
  redis.call('PEXPIRE',key,math.max(expires-now+60000,60000))
  return 1
`;

const RENEW_SCRIPT = `
  local key=KEYS[1]
  local session=ARGV[1]
  local now=tonumber(ARGV[2])
  local expires=tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
  if not redis.call('ZSCORE',key,session) then return 0 end
  redis.call('ZADD',key,expires,session)
  redis.call('PEXPIRE',key,math.max(expires-now+60000,60000))
  return 1
`;

const RELEASE_SCRIPT = `
  local key=KEYS[1]
  local removed=redis.call('ZREM',key,ARGV[1])
  if redis.call('ZCARD',key)==0 then redis.call('DEL',key) end
  return removed
`;

const PROGRESS_CACHE_SCRIPT = `
  local key=KEYS[1]
  local ordinal=ARGV[1]
  local seq=ARGV[2]
  local payload=ARGV[3]
  local ttl=tonumber(ARGV[4])
  local oldOrdinal=redis.call('HGET',key,'ordinal')
  local oldSeq=redis.call('HGET',key,'seq')
  local function compare(a,b)
    a=string.gsub(a,'^0+',''); b=string.gsub(b,'^0+','')
    if a=='' then a='0' end
    if b=='' then b='0' end
    if string.len(a)>string.len(b) then return 1 end
    if string.len(a)<string.len(b) then return -1 end
    if a>b then return 1 end
    if a<b then return -1 end
    return 0
  end
  if oldOrdinal and oldSeq then
    local ordinalCompare=compare(ordinal,oldOrdinal)
    if ordinalCompare<0 or (ordinalCompare==0 and compare(seq,oldSeq)<=0) then return 0 end
  end
  redis.call('HSET',key,'ordinal',ordinal,'seq',seq,'payload',payload)
  redis.call('PEXPIRE',key,ttl)
  return 1
`;

@Injectable()
export class PlaybackLeaseStore {
  constructor(
    @Inject('STREAMING_REDIS') private readonly redis: Redis,
    @Inject(STREAMING_CONFIG) private readonly config: StreamingConfig,
  ) {}

  async ping(): Promise<void> {
    const reply = await this.redis.ping();
    if (reply !== 'PONG') throw new Error('Redis did not respond to PING');
  }

  async reserve(userId: string, sessionId: string, limit: number, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    const result = Number(await this.redis.eval(RESERVE_SCRIPT, 1, this.userKey(userId), sessionId, now, expiresAtMs, limit));
    return result > 0;
  }

  async renew(userId: string, sessionId: string, expiresAtMs: number): Promise<boolean> {
    const result = Number(await this.redis.eval(RENEW_SCRIPT, 1, this.userKey(userId), sessionId, Date.now(), expiresAtMs));
    return result === 1;
  }

  async release(userId: string, sessionId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.userKey(userId), sessionId);
  }

  async releaseMany(userId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const key = this.userKey(userId);
    await this.redis.multi().zrem(key, ...sessionIds).exec();
    await this.redis.expire(key, this.config.sessionTtlSeconds + 60).catch(() => undefined);
  }

  async getProgressCache(profileId: string, playableId: string): Promise<string | null> {
    return (await this.redis.hget(this.progressKey(profileId, playableId), 'payload')) ?? null;
  }

  async cacheProgress(profileId: string, playableId: string, ordinal: string, seq: string, payload: string): Promise<void> {
    await this.redis.eval(PROGRESS_CACHE_SCRIPT, 1, this.progressKey(profileId, playableId), ordinal, seq, payload, 60_000);
  }

  async deleteProfileProgressCache(profileId: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `movieapp:progress:${profileId}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  progressKey(profileId: string, playableId: string): string {
    return `movieapp:progress:${profileId}:${playableId}`;
  }

  private userKey(userId: string): string {
    return `movieapp:playback:user:${userId}:sessions`;
  }
}
