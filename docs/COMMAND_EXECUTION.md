# Verified command execution

`SignedCommandExecutor` composes three boundaries that should remain separate but ordered:

```text
signed envelope
     |
     v
cryptographic verification + trusted key resolution
     |
     v
configured policy gates
     |
     v
explicit clearinghouse operation map
     |
     v
transaction kernel + persisted idempotency/CAS
```

The executor exists to make the secure composition path easy without making the clearinghouse kernel responsible for cryptography or policy.

## Verification happens inside the executor

Callers provide the raw signed envelope to `execute()`. The executor calls `verifyCommand()` itself before reading actor identity or dispatching the operation.

This avoids an easy integration bug where application code verifies an envelope in one path but accidentally calls the domain kernel using fields copied from an unverified envelope in another path.

The trusted result supplies:

- authenticated `actorId`;
- signed `idempotencyKey`;
- signed optimistic `expectedVersion`;
- canonical command hash;
- nonce/key replay metadata.

## Closed operation map

The executor never performs reflective dispatch such as:

```js
market[command.operation](...)
```

Instead, v1 supports an explicit closed map:

```text
asset.register
offer.create
order.reserve
order.fund
order.deliver
order.settle
order.cancel
order.expire
```

Unsupported strings fail with `UNSUPPORTED_OPERATION` even when their signatures are valid.

This prevents a signer from reaching helper methods, constructors, prototype properties, or future domain methods that were never intentionally exposed through the signed-command protocol.

Adding a signed operation is therefore an explicit protocol change requiring a reviewed handler and tests.

`order.expire` mirrors the objective schema-v2 reservation expiry transition: the order must still be unfunded, it must have a seller-configured funding deadline, and that deadline must already be due. Any authenticated signer may trigger the transition because authorization is derived from objective state, not party privilege. Capacity restoration still occurs atomically inside the clearinghouse mutation.

## Policy ordering

When a `PolicyGateEngine` is configured, it runs **after** signature/key authorization but **before** the clearinghouse mutation.

Policy receives attributable actor context including:

- `actorId`;
- signing `keyId`;
- canonical `commandHash`.

It also receives the signed operation/payload and deployment-supplied policy context.

`deny` and `review` both stop automated execution through `requireAllowed()`. If policy blocks, the clearinghouse revision remains unchanged.

Authentication and policy solve different questions:

- signature verification: *which authorized key signed this command?*
- policy: *may this authenticated actor perform this operation under current deployment rules?*

## Retry behavior

A signed envelope can be retransmitted because of an intermittent link, queue redelivery, or ambiguous network failure. The signed `idempotencyKey` is passed directly into clearinghouse command context.

The clearinghouse therefore returns the original persisted result when the same actor/operation/key/input is replayed, rather than applying the economic mutation twice.

A deployment may additionally maintain a single-use nonce cache. Nonce replay protection and economic idempotency remain separate controls as described in [`SIGNED_COMMANDS.md`](SIGNED_COMMANDS.md).

## Optimistic concurrency

`expectedVersion` is signed and becomes the domain command's optimistic-concurrency expectation. An intermediary cannot strip or weaken it without invalidating the signature.

This is especially important for delayed/offline commands: a command signed against version 3 should not silently execute later against version 8 if the operation requires a current resource version.

## Order action payloads

Actions targeting an existing order carry `orderId` inside the signed payload. The explicit handler extracts that identifier and passes the remaining signed fields to the matching domain method.

Example:

```json
{
  "operation": "order.fund",
  "payload": {
    "orderId": "order-123",
    "amount": "10000",
    "reference": "processor:funding:001"
  },
  "expectedVersion": 1
}
```

The order ID, amount, reference, actor, idempotency key, and version expectation are all covered by the signed envelope.

For objective expiry the payload is deliberately minimal:

```json
{
  "operation": "order.expire",
  "payload": {
    "orderId": "order-123"
  },
  "expectedVersion": 1
}
```

The kernel evaluates the actual persisted funding deadline at execution time; the caller does not supply or override the deadline in the signed payload.

## What the executor does not do

The executor intentionally does not provide:

- replay-cache persistence;
- key custody or rotation;
- DID/credential resolution by itself;
- policy configuration;
- HTTP routing;
- settlement-rail orchestration;
- delivery-proof verification;
- human review workflow persistence.

Those remain composable modules. The executor only guarantees the ordering and closed dispatch path from verified intent to a clearinghouse mutation.
