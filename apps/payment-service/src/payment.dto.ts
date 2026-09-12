import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class SubscribeDto {
  @IsString() @MinLength(1) @MaxLength(80) planId!: string;
  @IsIn(['card', 'wallet', 'bank_transfer']) paymentMethod!: 'card' | 'wallet' | 'bank_transfer';
}
