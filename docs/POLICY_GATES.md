# Policy gates

The clearinghouse kernel should conserve capacity and enforce transaction state—not encode every legal, safety, insurance, or mission rule that may apply to a participant or service.

`PolicyGateEngine` provides an attributable pre-command policy boundary for deployment-specific rules.

## Placement

A typical mutation flow is:

```text
authenticate / verify signature
            |
            v
       policy gates
            |
        allow only
            |
            v
 clearinghouse command
```

Policy input may include authenticated actor claims, the intended operation, the target resource/contract, and deployment context. The policy engine does not authenticate callers itself.

## Decisions

Each gate returns exactly one decision:

- `allow` — the gate has no blocking condition;
- `deny` — the operation must not proceed under this gate;
- `review` — automated execution must stop pending a human or higher-assurance workflow.

Aggregate precedence is:

```text
deny > review > allow
```

An evaluator failure does not become `allow`; it fails closed as `POLICY_GATE_FAILED` with the gate identifier attached.

## Attribution and versioning

Every registered gate has a stable `gateId` and `version`. A normalized result includes:

- gate ID/version;
- decision and reason;
- evaluation timestamp;
- optional verified claims/evidence;
- canonical `decisionHash`.

The full evaluation bundle receives an `evaluationHash`.

A deployment should persist or externally attach those hashes/results to the workflow that authorized a mutation when auditability matters.

Changing policy behavior should change the gate version. Re-registering the same gate ID inside one engine instance is rejected instead of silently replacing policy.

## Example gate classes

The engine is intentionally generic enough for policies such as:

- participant/account standing;
- licensing or operating authority;
- insurance coverage;
- sanctions/export-control screening performed by an approved service;
- mission-specific approval;
- asset-control credentials;
- orbital/surface operating zones;
- conjunction-risk constraints;
- ground-station spectrum/regulatory constraints;
- service-specific safety limits.

None of these is automatically satisfied by using the policy engine. The deployment chooses and validates its actual evaluators.

## CCSDS and orbital safety

When an orbital-safety gate evaluates state vectors or conjunction information, it should consume standardized artifacts where practical rather than proprietary structures. CCSDS Orbit Data Messages and Conjunction Data Messages are the natural integration boundary already identified in [`STANDARDS.md`](STANDARDS.md).

A policy result should reference/digest the exact evidence and model/profile version that produced the decision. Collision-risk thresholds and maneuver policy are deployment/mission decisions, not universal clearinghouse constants.

## Empty policy sets

An engine with zero registered gates returns `allow`. This is deliberate: the library does not invent policy that was never configured.

A production deployment that requires mandatory controls should validate its configured gate set at startup (for example, require a licensing gate and mission-safety gate) before accepting traffic.

## Review workflows

`review` is not a softer `allow`. `requireAllowed()` rejects both `deny` and `review` so automated callers cannot accidentally continue.

A higher-level workflow can route `review` decisions to a human or approval system, gather new evidence, then run a newly attributable policy evaluation before executing the domain command.

## Trust boundary

Policy code can be safety- or compliance-critical. A production system should consider:

- authenticated/versioned policy configuration;
- change review and deployment provenance;
- deterministic inputs where possible;
- timeout/failure behavior for external policy services;
- audit retention for policy evidence and decisions;
- separation between policy authors and transaction operators where appropriate.

The clearinghouse remains deliberately unaware of those organizational choices.
