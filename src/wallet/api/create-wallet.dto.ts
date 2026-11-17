import { Type } from 'class-transformer';
import { IsObject, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

export class InitialBalanceDto {
  @IsString()
  // Decimal string, never a JS number. The 18 digit limit matches numeric(20,2).
  @Matches(/^(?:0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @MaxLength(160)
  playerId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  initialBalance!: InitialBalanceDto;
}
