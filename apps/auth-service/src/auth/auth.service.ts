import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
const validRoles: UserRole[] = ['user', 'admin', 'content_manager', 'content_editor', 'support'];

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

    let passwordValid: boolean;
    try {
      passwordValid = await argon2.verify(user.passwordHash, input.password);
    } catch {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
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
        const remaining = active.filter((session) => !toRevoke.has(session.id));
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

  async adminUsers(query: { page?: number; pageSize?: number; status?: string; email?: string; }): Promise<Record<string, unknown>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const values: unknown[] = [];
    const where: string[] = [`role='user'`];
    if (query.status && ['active', 'banned', 'deleted'].includes(query.status)) { values.push(query.status); where.push(`status=$${values.length}`); }
    if (query.email?.trim()) { values.push(`${this.normalizeEmail(query.email)}%`); where.push(`lower(email) LIKE $${values.length}`); }
    const condition = where.join(' AND ');
    const count = await this.dataSource.query(`SELECT count(*)::int AS count FROM users WHERE ${condition}`, values) as Array<{ count: number }>;
    values.push(pageSize, (page - 1) * pageSize);
    const items = await this.dataSource.query(`SELECT id,email,full_name AS "fullName",status,created_at AS "createdAt" FROM users WHERE ${condition} ORDER BY created_at DESC,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items, page, pageSize, totalItems: count[0]?.count ?? 0 };
  }

  async adminUser(userId: string): Promise<Record<string, unknown>> {
    const row = (await this.dataSource.query(`SELECT id,email,full_name AS "fullName",status,created_at AS "createdAt",updated_at AS "updatedAt" FROM users WHERE id=$1 AND role='user'`, [userId]))[0];
    if (!row) throw new NotFoundException('User not found');
    return row as Record<string, unknown>;
  }

  async adminSessions(userId: string): Promise<Record<string, unknown>> {
    await this.assertEndUser(userId);
    const items = await this.dataSource.query(`SELECT id,device_id AS "deviceId",device_name AS "deviceName",created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt", CASE WHEN revoked_at IS NULL AND expires_at>now() THEN true ELSE false END AS active FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return { items };
  }

  async suspendUser(actorId: string, userId: string, reason: string, requestId: string, suspended: boolean): Promise<void> {
    const cleanReason = this.reason(reason);
    if (actorId === userId) throw new ForbiddenException('Administrators cannot change their own account through user operations');
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      if (!user || user.role !== 'user') throw new NotFoundException('User not found');
      if (user.status === 'deleted') throw new ConflictException('Deleted user cannot be changed');
      user.status = suspended ? 'banned' : 'active';
      await manager.getRepository(User).save(user);
      if (suspended) {
        const now = new Date();
        await manager.getRepository(AuthSession).update({ userId }, { revokedAt: now });
        await manager.getRepository(RefreshToken).createQueryBuilder().update().set({ revokedAt: now }).where(`session_id IN (SELECT id FROM auth_sessions WHERE user_id=:userId)`, { userId }).execute();
      }
      await this.audit(manager, actorId, suspended ? 'user.suspended' : 'user.unsuspended', 'user', userId, userId, cleanReason, requestId);
    });
  }

  async deleteUser(actorId: string, userId: string, reason: string, requestId: string): Promise<void> {
    const cleanReason = this.reason(reason);
    if (actorId === userId) throw new ForbiddenException('Administrators cannot delete themselves');
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      if (!user || user.role !== 'user') throw new NotFoundException('User not found');
      if (user.status === 'deleted') return;
      user.status = 'deleted';
      await manager.getRepository(User).save(user);
      const now = new Date();
      await manager.getRepository(AuthSession).update({ userId }, { revokedAt: now });
      await manager.getRepository(RefreshToken).createQueryBuilder().update().set({ revokedAt: now }).where(`session_id IN (SELECT id FROM auth_sessions WHERE user_id=:userId)`, { userId }).execute();
      await this.audit(manager, actorId, 'user.deleted', 'user', userId, userId, cleanReason, requestId);
    });
  }

  async revokeSession(actorId: string, userId: string, sessionId: string, reason: string, requestId: string): Promise<void> {
    const cleanReason = this.reason(reason);
    await this.dataSource.transaction(async (manager) => {
      await this.assertEndUser(userId, manager);
      const session = await manager.getRepository(AuthSession).findOne({ where: { id: sessionId, userId }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new NotFoundException('Login session not found');
      const now = new Date();
      await manager.getRepository(AuthSession).update({ id: sessionId }, { revokedAt: now });
      await manager.getRepository(RefreshToken).update({ sessionId }, { revokedAt: now });
      await this.audit(manager, actorId, 'user.session_revoked', 'auth_session', sessionId, userId, cleanReason, requestId);
    });
  }

  async revokeAllSessions(actorId: string, userId: string, reason: string, requestId: string): Promise<void> {
    const cleanReason = this.reason(reason);
    await this.dataSource.transaction(async (manager) => {
      await this.assertEndUser(userId, manager);
      const now = new Date();
      await manager.getRepository(AuthSession).update({ userId }, { revokedAt: now });
      await manager.getRepository(RefreshToken).createQueryBuilder().update().set({ revokedAt: now }).where(`session_id IN (SELECT id FROM auth_sessions WHERE user_id=:userId)`, { userId }).execute();
      await this.audit(manager, actorId, 'user.sessions_revoked_all', 'user', userId, userId, cleanReason, requestId);
    });
  }

  async adminStaff(): Promise<Record<string, unknown>> {
    const items = await this.dataSource.query(`SELECT id,email,full_name AS "fullName",role,status,created_at AS "createdAt" FROM users WHERE role<>'user' ORDER BY created_at DESC,id DESC`);
    return { items };
  }

  async promoteStaff(actorId: string, email: string, role: UserRole, reason: string, requestId: string): Promise<Record<string, unknown>> {
    if (!['admin', 'content_manager', 'content_editor', 'support'].includes(role)) throw new BadRequestException('Staff role is invalid');
    const cleanReason = this.reason(reason);
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { email: this.normalizeEmail(email) }, lock: { mode: 'pessimistic_write' } });
      if (!user || user.status !== 'active') throw new NotFoundException('An active registered user with this email is required');
      user.role = role;
      await manager.getRepository(User).save(user);
      await this.audit(manager, actorId, 'staff.promoted', 'user', user.id, user.id, cleanReason, requestId, { role });
      return { id: user.id, email: user.email, fullName: user.fullName, role: user.role, status: user.status };
    });
  }

  async changeStaffRole(actorId: string, staffId: string, role: UserRole, reason: string, requestId: string): Promise<void> {
    if (!['admin', 'content_manager', 'content_editor', 'support'].includes(role)) throw new BadRequestException('Staff role is invalid');
    if (actorId === staffId && role !== 'admin') throw new ForbiddenException('Administrators cannot lower their own role');
    const cleanReason = this.reason(reason);
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id: staffId }, lock: { mode: 'pessimistic_write' } });
      if (!user || user.role === 'user') throw new NotFoundException('Staff account not found');
      user.role = role;
      await manager.getRepository(User).save(user);
      await this.audit(manager, actorId, 'staff.role_changed', 'user', staffId, staffId, cleanReason, requestId, { role });
    });
  }

  async removeStaff(actorId: string, staffId: string, reason: string, requestId: string): Promise<void> {
    if (actorId === staffId) throw new ForbiddenException('Administrators cannot remove themselves');
    const cleanReason = this.reason(reason);
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({ where: { id: staffId }, lock: { mode: 'pessimistic_write' } });
      if (!user || user.role === 'user') throw new NotFoundException('Staff account not found');
      if (user.role === 'admin') {
        const admins = await manager.getRepository(User).countBy({ role: 'admin', status: 'active' });
        if (admins <= 1) throw new ConflictException('The final active administrator cannot be removed');
      }
      user.role = 'user';
      await manager.getRepository(User).save(user);
      await this.audit(manager, actorId, 'staff.removed', 'user', staffId, staffId, cleanReason, requestId);
    });
  }

  async auditLogs(query: { page?: number; pageSize?: number; actorId?: string; action?: string; targetUserId?: string; from?: string; to?: string; }): Promise<Record<string, unknown>> {
    const page = Math.max(1, Math.floor(query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const values: unknown[] = []; const where: string[] = [];
    for (const [column, value] of [['actor_id', query.actorId], ['action', query.action], ['target_user_id', query.targetUserId]] as const) {
      if (value?.trim()) { values.push(value.trim()); where.push(`${column}=$${values.length}`); }
    }
    if (query.from?.trim()) { values.push(query.from); where.push(`created_at >= $${values.length}::timestamptz`); }
    if (query.to?.trim()) { values.push(query.to); where.push(`created_at <= $${values.length}::timestamptz`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.dataSource.query(`SELECT count(*)::int AS count FROM admin_audit_logs ${clause}`, values) as Array<{ count: number }>;
    values.push(pageSize, (page - 1) * pageSize);
    const items = await this.dataSource.query(`SELECT id,actor_id AS "actorId",action,target_type AS "targetType",target_id AS "targetId",target_user_id AS "targetUserId",reason,metadata,request_id AS "requestId",created_at AS "createdAt" FROM admin_audit_logs ${clause} ORDER BY created_at DESC,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items, page, pageSize, totalItems: count[0]?.count ?? 0 };
  }

  async recordExternalAudit(actorId: string, input: {
    action: string; targetType: string; targetId: string; targetUserId?: string | null;
    reason: string; requestId: string; metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(input.action) || !/^[a-z][a-z0-9_.-]{2,100}$/.test(input.targetType) || !input.targetId.trim()) {
      throw new BadRequestException('Audit event is invalid');
    }
    const cleanReason = this.reason(input.reason);
    await this.dataSource.transaction(async (manager) => {
      const actor = await manager.getRepository(User).findOneBy({ id: actorId });
      if (!actor || actor.status !== 'active' || actor.role === 'user') throw new ForbiddenException('Audit actor is not an active staff account');
      await this.audit(manager, actorId, input.action, input.targetType, input.targetId.trim(), input.targetUserId ?? null, cleanReason, input.requestId, input.metadata ?? {});
    });
  }

  async adminMetrics(): Promise<Record<string, number>> {
    const rows = await this.dataSource.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='banned')::int AS banned, count(*) FILTER (WHERE created_at>=date_trunc('day',now()))::int AS new_today FROM users WHERE role='user'`) as Array<{ active: number; banned: number; new_today: number }>;
    const row = rows[0] ?? { active: 0, banned: 0, new_today: 0 };
    return { activeUsers: row.active, bannedUsers: row.banned, newUsersToday: row.new_today };
  }

  private reason(value: string): string {
    const clean = value?.trim();
    if (!clean || clean.length < 10 || clean.length > 1000) throw new BadRequestException('Reason must be 10 to 1000 characters');
    return clean;
  }

  private async assertEndUser(userId: string, manager = this.dataSource.manager): Promise<void> {
    const user = await manager.getRepository(User).findOneBy({ id: userId });
    if (!user || user.role !== 'user') throw new NotFoundException('User not found');
  }

  private async audit(manager: DataSource['manager'], actorId: string, action: string, targetType: string, targetId: string, targetUserId: string | null, reason: string, requestId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await manager.query(`INSERT INTO admin_audit_logs(id,actor_id,action,target_type,target_id,target_user_id,reason,metadata,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [randomUUID(), actorId, action, targetType, targetId, targetUserId, reason, JSON.stringify(metadata), requestId]);
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
