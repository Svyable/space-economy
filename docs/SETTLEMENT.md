# External settlement adapters

The clearinghouse records funding and settlement references, but it should not pretend that an external payment rail and the clearinghouse state store participate in one ACID transaction.

`SettlementAdapterRegistry` defines the external rail boundary while keeping payment providers, bank APIs, stablecoin networks, internal credits, and bilateral settlement out of the transaction kernel.

## Settlement asset routing

Adapters are registered for an exact settlement asset identifier, for example:

```text
iso4217:USD
```

The identifier describes the unit of account/rail contract; it does not imply a specific bank, custodian, processor, token, or jurisdiction.

A deployment can choose a different identifier namespace for other rails.

## Adapter descriptor

An adapter declares:

- `adapterId` — attributable implementation/rail identity;
- `adapterVersion` — behavior/profile version;
- `fund(...)` — create or confirm buyer funding;
- `settle(...)` — release/transfer the contracted amount;
- optional `refund(...)` — reverse a completed settlement when the rail supports it.

Every side-effecting call receives a required `idempotencyKey`. Production adapters MUST make that key effective at the rail or in durable adapter-owned state so a network retry cannot duplicate a charge or transfer.

## Receipts

Adapters return a rail-specific result that the registry normalizes into a receipt:

```json
{
  "operation": "fund",
  "status": "confirmed",
  "reference": "processor:funding:001",
  "adapterId": "processor.example:usd",
  "adapterVersion": "2.1.0",
  "amount": {
    "settlementAsset": "iso4217:USD",
    "amount": "10000",
    "scale": 2
  },
  "occurredAt": "2026-08-26T21:00:00.000Z",
  "receiptHash": "sha256:..."
}
```

Status is deliberately closed:

- `confirmed` — the adapter considers the operation complete enough for its configured policy;
- `pending` — the external rail has accepted work but completion is not final;
- `rejected` — the rail/policy declined the operation.

The registry never converts `pending` into success.

## Exact amount invariant

The registry routes and receipts the exact `order.total` object from the clearinghouse: `{ settlementAsset, amount, scale }`. It does not recompute monetary totals or use floating-point arithmetic.

Rail fees, spreads, gas, correspondent-bank charges, or processor costs belong in receipt metadata or a higher-level fee contract. They must not silently alter the clearinghouse contract amount.

## The two-system commit problem

A typical funding workflow crosses two durable systems:

1. call the external funding rail with an idempotency key;
2. receive a confirmed rail reference;
3. record that reference on the clearinghouse order;
4. if step 3 fails, retry the clearinghouse mutation with its own stable idempotency key.

Settlement has the same shape in the opposite economic direction.

This is a saga/reconciliation problem, not a distributed transaction the clearinghouse can wish away. Deployments need durable workflow state that can answer questions such as:

- Which confirmed rail receipts have not yet been recorded on orders?
- Which clearinghouse funding references cannot be found on the configured rail?
- Which pending operations need polling or webhook completion?
- Was a settlement retried after an ambiguous timeout?
- Does a refund/dispute require a compensating clearinghouse transition?

A future orchestration module should persist those workflow states and reconcile them explicitly.

## Security and compliance

The adapter boundary does not solve:

- custody or safeguarding requirements;
- KYC/KYB or sanctions screening;
- payment licensing;
- fraud/risk decisions;
- export controls;
- tax or accounting treatment;
- chain finality or reorganization policy;
- bank return windows, chargebacks, or disputes.

Those requirements depend on the selected rail and jurisdiction. The transaction kernel should consume attributable references/results rather than embedding one provider's rules.

## Refunds

Refund support is optional. An adapter without `refund()` fails with `REFUND_UNSUPPORTED` rather than pretending a reversal is possible.

That explicit capability matters because the v0.1 clearinghouse already refuses to silently cancel funded reservations. A future dispute/refund workflow should coordinate the external reversal and the corresponding clearinghouse state transition as a reconciled saga.
