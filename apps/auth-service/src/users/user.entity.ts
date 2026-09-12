import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type UserRole = 'user' | 'admin' | 'content_manager';
export type UserStatus = 'active' | 'banned' | 'deleted';

@Entity({ name: 'users' })
export class User {
  @PrimaryColumn('uuid') id!: string;
  @Column({ type: 'text' }) email!: string;
  @Column({ name: 'full_name', type: 'text' }) fullName!: string;
  @Column({ name: 'password_hash', type: 'text', select: false }) passwordHash!: string;
  @Column({ type: 'varchar', length: 32, default: 'user' }) role!: UserRole;
  @Column({ type: 'varchar', length: 32, default: 'active' }) status!: UserStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
