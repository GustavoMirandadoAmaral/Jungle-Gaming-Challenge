import { Injectable } from '@nestjs/common';
import { ProviderIdentityPort } from './provider-identity.port.js';

/** Authentication is intentionally out of scope; replace this adapter with OIDC validation when needed. */
@Injectable()
export class NoopProviderIdentity extends ProviderIdentityPort {
  authorize(_providerId: string): void {
    // Deliberately allow requests while keeping an explicit dependency boundary for a future IdP.
  }
}
