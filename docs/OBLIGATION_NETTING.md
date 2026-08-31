# Non-custodial obligation netting

`buildObligationNettingCycle()` deterministically reduces a set of attributable obligations in one settlement asset into participant net positions and external settlement instructions.

It is accounting and clearing logic, not custody.

## Input boundary

Every obligation binds:

- unique `obligationId`;
- debtor and creditor identities;
- exact positive money `{settlementAsset, amount, scale}`;
- unique `sourceRef`;
- canonical `sourceDigest`.

A cycle also binds an immutable cutoff:

- local `{type: "ledger-revision", clearinghouseId, revision}`; or
- remote `{type: "federation-checkpoint", clearinghouseId, checkpointHash}`.

The engine does not fetch or trust source obligations itself. A caller must construct the eligible obligation set from an authoritative ledger/projection and supply the cutoff that makes that set attributable.

## Exact arithmetic

All obligations in a cycle use one settlement asset. Cross-asset netting is rejected rather than converted.

Decimal scales are aligned by multiplying integer amounts with powers of ten. Floating point is never used.

For each obligation:

```text
debtor position   -= amount
creditor position += amount
```

The sum of every participant net position must therefore be exactly zero. Any non-zero result is treated as corrupt netting state.

## Settlement instructions

Payers and receivers are sorted by participant ID. A deterministic greedy matcher then emits payer-to-receiver instructions until every net position is exhausted.

This is not an optimization claim. It is a simple deterministic settlement decomposition with at most the usual payer/receiver chain size. A future deployment can choose another declared algorithm, but it must be separately versioned and attributable.

The returned cycle reports:

- gross obligation notional;
- net settlement notional;
- netting reduction;
- participant gross payable/receivable and signed net position;
- deterministic external settlement instructions;
- immutable `cycleHash`;
- source cutoff and obligation evidence.

Instruction IDs are derived from the cycle hash and instruction content.

## Collateral attestations

Optional collateral evidence is external and attributable. Each attestation binds:

- subject;
- exact settlement-asset amount;
- verifier/profile identity;
- evidence digest;
- validity window.

An optional `minimumCoverageBps` policy checks active collateral against each participant's net payable position with exact integer arithmetic.

The engine never turns an attestation into an account balance. It reports `custody: false` and does not claim the verifier will honor, freeze, or transfer the referenced value.

Expired evidence cannot satisfy a coverage policy.

## Finality boundary

A netting cycle does **not**:

- move money;
- mark clearinghouse orders settled;
- custody collateral;
- guarantee a settlement rail will accept an instruction;
- claim legal novation;
- perform FX conversion;
- rewrite source obligations.

A future reconciliation layer should record external rail receipts against instruction IDs and represent corrections as new attributable obligations rather than editing the locked cycle.

## Federation

A federation-checkpoint cutoff allows the same deterministic engine to operate over obligations proven from a remote clearinghouse history. Trust policy remains external: the caller must first verify the remote checkpoint, ledger extension, identity/key authorization, and obligation eligibility.

No global consensus or shared ACID boundary is implied.

## Intended path

The sequence is:

```text
orders / other attributable obligations
    -> eligibility + cutoff
    -> deterministic netting cycle
    -> policy / collateral checks
    -> external settlement instructions
    -> rail receipts + reconciliation
```

This lets the project evolve from transaction execution toward real clearing infrastructure without silently becoming a bank.
