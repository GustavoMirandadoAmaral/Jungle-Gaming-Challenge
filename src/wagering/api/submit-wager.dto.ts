import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { WagerTransactionKind } from '../domain/enums/wager-transaction-kind.enum.js';

export class WagerMoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWagerDto {
  @IsString() @MaxLength(160)
  providerId!: string;

  @IsString() @MaxLength(200)
  externalTransactionId!: string;

  @IsString() @MaxLength(160)
  playerId!: string;

  @IsString() @Matches(/^[0-9a-f-]{36}$/i)
  walletId!: string;

  @IsString() @MaxLength(200)
  roundId!: string;

  @IsString() @MaxLength(200)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsObject()
  @ValidateNested()
  @Type(() => WagerMoneyDto)
  money!: WagerMoneyDto;

  @IsOptional() @IsString() @MaxLength(200)
  referenceExternalTransactionId?: string;
}
