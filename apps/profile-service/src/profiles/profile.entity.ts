import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'profiles' })
@Index('idx_profiles_user_active', ['userId', 'createdAt', 'id'], { where: 'deleted_at IS NULL' })
export class Profile {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'avatar_id', type: 'smallint', nullable: true })
  avatarId!: number | null;

  @Column({ name: 'is_kids', type: 'boolean', default: false })
  isKids!: boolean;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
