import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'refresh_tokens' })
@Index('uq_refresh_tokens_hash', ['tokenHash'], { unique: true })
@Index('idx_refresh_tokens_session', ['sessionId'])
export class RefreshToken {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'session_id', type: 'uuid' }) sessionId!: string;
  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true }) tokenHash!: string;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true }) usedAt!: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) revokedAt!: Date | null;
  @Column({ name: 'replaced_by', type: 'uuid', nullable: true }) replacedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
