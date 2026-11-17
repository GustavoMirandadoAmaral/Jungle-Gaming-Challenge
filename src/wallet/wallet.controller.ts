import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { DuplicateWalletError } from '../shared/domain/errors/domain-error.js';
import { CreateWallet } from './application/create-wallet.js';
import { CreateWalletDto } from './api/create-wallet.dto.js';
import { GetWallet } from './application/get-wallet.js';
import { WalletNotFoundError } from '../shared/domain/errors/domain-error.js';

@Controller('wallets')
export class WalletController {
  constructor(private readonly createWallet: CreateWallet, private readonly getWallet: GetWallet) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    try {
      return await this.createWallet.execute(body);
    } catch (error) {
      if (error instanceof DuplicateWalletError) {
        throw new ConflictException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Get(':walletId')
  async byId(@Param('walletId') walletId: string) {
    try {
      return await this.getWallet.byId(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.getWallet.ledger(walletId, cursor, limit);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }
}
