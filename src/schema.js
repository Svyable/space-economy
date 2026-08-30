import { SnapshotMigrationRegistry } from './migrations.js';

export const CURRENT_SCHEMA_VERSION = 4;

/**
 * Clearinghouse-owned persisted-state migrations.
 *
 * Historical ledger events are intentionally left byte-for-byte unchanged.
 */
export function createClearinghouseMigrationRegistry() {
  return new SnapshotMigrationRegistry({ currentVersion: CURRENT_SCHEMA_VERSION })
    .register(1, (snapshot) => ({
      ...snapshot,
      schemaVersion: 2,
      offers: (snapshot.offers ?? []).map((offer) => ({
        ...offer,
        reservationTtlSeconds: offer.reservationTtlSeconds ?? null,
      })),
      orders: (snapshot.orders ?? []).map((order) => ({
        ...order,
        fundingDueAt: order.fundingDueAt ?? null,
        expiration: order.expiration ?? null,
      })),
    }))
    .register(2, (snapshot) => ({
      ...snapshot,
      schemaVersion: 3,
      commercialCommitments: snapshot.commercialCommitments ?? [],
    }))
    .register(3, (snapshot) => ({
      ...snapshot,
      schemaVersion: 4,
      capacityRights: snapshot.capacityRights ?? [],
    }));
}
