import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { TransactionNotFoundError } from '../shared/domain/errors/domain-error.js';
import { GetWagerTransaction } from './application/get-wager-transaction.js';
import { ProviderIdentityPort } from './application/provider-identity.port.js';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(private readonly getWager: GetWagerTransaction, private readonly providerIdentity: ProviderIdentityPort) {}

  @Get(':externalTransactionId')
  async byProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      await this.providerIdentity.authorize(providerId);
      return await this.getWager.byExternal(providerId, externalTransactionId);
    } catch (error) {
      if (error instanceof TransactionNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }
}
