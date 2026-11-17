import { BadRequestException, ConflictException, Controller, Headers, HttpCode, HttpStatus, NotFoundException, Post, UnprocessableEntityException, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, IdempotencyConflictError, WalletNotFoundError } from '../shared/domain/errors/domain-error.js';
import { ProcessWagerTransaction } from './application/process-wager-transaction.js';
import { SubmitWagerDto } from './api/submit-wager.dto.js';
import { WagerTransactionStatus } from './domain/enums/wager-transaction-status.enum.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWager: ProcessWagerTransaction) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitWagerDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (idempotencyKey.length > 300) {
      throw new BadRequestException('Idempotency-Key must be at most 300 characters');
    }

    try {
      const result = await this.processWager.execute({
        ...body,
        idempotencyKey,
      });
      if (result.status === WagerTransactionStatus.Rejected) {
        response.status(422);
      }
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      if (error instanceof DomainError) {
        throw new UnprocessableEntityException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }
}
