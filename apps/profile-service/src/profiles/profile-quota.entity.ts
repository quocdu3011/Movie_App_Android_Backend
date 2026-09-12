import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'profile_quotas' })
export class ProfileQuota {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
