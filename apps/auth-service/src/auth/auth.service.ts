import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { AuthSession } from '../sessions/auth-session.entity';
import { RefreshToken } from '../sessions/refresh-token.entity';
import { User, UserRole } from '../users/user.entity';
import { signAccessToken } from '@movie/shared-auth';

const INVALID_CREDENTIALS = 'Invalid credentials';
const validRoles: UserRole[] = ['user', 'admin', 'content_manager'];

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly dataSource: DataSource, @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private publicUser(user: User): PublicUser {
    return { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
  }

  private async createTokenPair(
    manager: DataSource['manager'],
    user: User,
    session: AuthSession,
  ): Promise<TokenPair> {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000);
    const tokenRepo = manager.getRepository(RefreshToken);
    await tokenRepo.save(tokenRepo.create({
      id: randomUUID(),
      sessionId: session.id,
      tokenHash: this.tokenHash(refreshToken),
      expiresAt: refreshExpiresAt,
      usedAt: null,
      revokedAt: null,
      replacedBy: null,
    }));
    session.expiresAt = refreshExpiresAt;
    await manager.getRepository(AuthSession).save(session);

    const accessToken = signAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
      iss: this.config.issuer,
      aud: this.config.audience,
      iat: nowSeconds,
      exp: nowSeconds + this.config.accessTtlSeconds,
    }, this.config.keyPair);
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTtlSeconds,
      user: this.publicUser(user),
    };
  }

  async pingDatabase(): Promise<void> {
    await this.dataSource.query("SELECT 1");
  }

  async register(input: { email: string; password: string; fullName: string }): Promise<PublicUser> {
    const email = this.normalizeEmail(input.email);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    const userRepo = this.dataSource.getRepository(User);
    const user = userRepo.create({
      id: randomUUID(),
      email,
      fullName: input.fullName.trim(),
      passwordHash,
      role: 'user',
      status: 'active',
    });
    try {
      return this.publicUser(await userRepo.save(user));
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('An account with this email already exists');
      throw error;
    }
  }

  async login(input: {
    email: string; password: string; deviceId: string; deviceName?: string;
  }): Promise<TokenPair> {
    const email = this.normalizeEmail(input.email);
    const user = await this.dataSource.getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('lower(user.email) = :email', { email })
      .getOne();
    if (!user || user.status !== 'active') throw new UnauthorizedException(INVALID_CREDENTIALS);

    let passwordValid = false;
    try {
      passwordValid = await argon2.verify(user.passwordHash, input.password);
    } catch {
      passwordValid = false;
    }
    if (!passwordValid) throw new UnauthorizedException(INVALID_CREDENTIALS);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const lockedUser = await manager.getRepository(User).findOne({
          where: { id: user.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedUser || lockedUser.status !== 'active') throw new UnauthorizedException(INVALID_CREDENTIALS);

        const now = new Date();
        const sessions = await manager.getRepository(AuthSession).find({
          where: { userId: lockedUser.id, revokedAt: IsNull() },
          order: { createdAt: 'ASC' },
        });
        const active = sessions.filter((session) => session.expiresAt > now);
        const deviceSessions = active.filter((session) => session.deviceId === input.deviceId);
        const toRevoke = new Set(deviceSessions.map((session) => session.id));
        let remaining = active.filter((session) => !toRevoke.has(session.id));
        while (remaining.length >= this.config.maxDevices) {
          const oldest = remaining.shift();
          if (oldest) toRevoke.add(oldest.id);
        }

        if (toRevoke.size > 0) {
          await manager.getRepository(AuthSession).update({ id: In([...toRevoke]) }, { revokedAt: now });
          await manager.getRepository(RefreshToken).update({ sessionId: In([...toRevoke]) }, { revokedAt: now });
        }

        const session = await manager.getRepository(AuthSession).save(manager.getRepository(AuthSession).create({
          id: randomUUID(),
          userId: lockedUser.id,
          deviceId: input.deviceId,
          deviceName: input.deviceName?.trim() || null,
          expiresAt: new Date(now.getTime() + this.config.refreshTtlDays * 86_400_000),
          revokedAt: null,
        }));
        return this.createTokenPair(manager, lockedUser, session);
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('Could not create an authentication session');
      throw error;
    }
  }

  async refresh(rawToken: string): Promise<TokenPair> {
    const tokenHash = this.tokenHash(rawToken);
    const result = await this.dataSource.transaction(async (manager) => {
      const tokenRepo = manager.getRepository(RefreshToken);
      const probe = await tokenRepo.findOne({ where: { tokenHash } });
      if (!probe) return { kind: 'invalid' as const };

      const sessionRepo = manager.getRepository(AuthSession);
      const session = await sessionRepo.findOne({
        where: { id: probe.sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      const token = await tokenRepo.findOne({
        where: { id: probe.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session || !token) return { kind: 'invalid' as const };
      const now = new Date();

      if (token.usedAt) {
        await sessionRepo.update({ id: session.id }, { revokedAt: now });
        await tokenRepo.update({ sessionId: session.id }, { revokedAt: now });
        return { kind: 'reused' as const };
      }
      if (token.revokedAt || token.expiresAt <= now || session.revokedAt || session.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }

      const user = await manager.getRepository(User).findOne({ where: { id: session.userId } });
      if (!user || user.status !== 'active') {
        await sessionRepo.update({ id: session.id }, { revokedAt: now });
        await tokenRepo.update({ sessionId: session.id }, { revokedAt: now });
        return { kind: 'invalid' as const };
      }

      token.usedAt = now;
      await tokenRepo.save(token);
      const pair = await this.createTokenPair(manager, user, session);
      const replacement = await tokenRepo.findOneByOrFail({ tokenHash: this.tokenHash(pair.refreshToken) });
      token.replacedBy = replacement.id;
      await tokenRepo.save(token);
      return { kind: 'ok' as const, pair };
    });

    if (result.kind === 'reused') {
      this.logger.warn('Refresh token reuse detected; authentication session revoked');
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (result.kind !== 'ok') throw new UnauthorizedException(INVALID_CREDENTIALS);
    return result.pair;
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = this.tokenHash(rawToken);
    await this.dataSource.transaction(async (manager) => {
      const token = await manager.getRepository(RefreshToken).findOneBy({ tokenHash });
      if (!token) return;
      const sessionRepo = manager.getRepository(AuthSession);
      const session = await sessionRepo.findOne({
        where: { id: token.sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) return;
      const now = new Date();
      await sessionRepo.update({ id: session.id }, { revokedAt: session.revokedAt ?? now });
      await manager.getRepository(RefreshToken).update({ sessionId: session.id }, { revokedAt: now });
    });
  }

  async validateSession(userId: string, sessionId: string): Promise<{
    active: boolean; userId: string; sessionId: string; role?: UserRole; email?: string; fullName?: string;
  }> {
    const session = await this.dataSource.getRepository(AuthSession).findOneBy({ id: sessionId, userId });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      return { active: false, userId, sessionId };
    }
    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user || user.status !== 'active' || !validRoles.includes(user.role)) {
      return { active: false, userId, sessionId };
    }
    return {
      active: true,
      userId: user.id,
      sessionId: session.id,
      role: user.role,
      email: user.email,
      fullName: user.fullName,
    };
  }

  async seedAdmin(): Promise<void> {
    const email = process.env.SEED_ADMIN_EMAIL?.trim();
    const password = process.env.SEED_ADMIN_PASSWORD;
    const fullName = process.env.SEED_ADMIN_FULL_NAME?.trim();
    if (!email || !password || !fullName) return;
    if (this.config.nodeEnv === 'production') throw new Error('Admin seed is forbidden in production');
    if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
    const normalized = this.normalizeEmail(email);
    const repo = this.dataSource.getRepository(User);
    const existing = await repo.findOneBy({ email: normalized });
    if (existing) {
      if (existing.role !== 'admin' || existing.status !== 'active') {
        throw new Error('Seed account exists but is not an active admin; resolve it explicitly');
      }
      return;
    }
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1,
    });
    const inserted = await this.dataSource.query(
      `INSERT INTO users (id,email,full_name,password_hash,role,status)
       VALUES ($1,$2,$3,$4,'admin','active')
       ON CONFLICT (lower(email)) DO NOTHING
       RETURNING id`,
      [randomUUID(), normalized, fullName, passwordHash],
    ) as Array<{ id: string }>;
    if (inserted.length) return;
    const raced = await repo.findOneBy({ email: normalized });
    if (!raced || raced.role !== 'admin' || raced.status !== 'active') {
      throw new ConflictException('Admin seed conflicts with a non-admin account');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
    return candidate.code === '23505' || candidate.driverError?.code === '23505';
  }
}
