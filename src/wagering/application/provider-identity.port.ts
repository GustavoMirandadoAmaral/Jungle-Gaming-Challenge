/** Extension point for validating a provider against an external identity provider. */
export abstract class ProviderIdentityPort {
  abstract authorize(providerId: string): Promise<void> | void;
}
