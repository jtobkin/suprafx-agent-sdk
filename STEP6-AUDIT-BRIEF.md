# STEP 6 AUDIT BRIEF — adversarial review of mirror / website / SDK changes

Auditor, not author. Fix nothing. Inputs: AGREED-PLAN §3 + A' + rule 3, STEP6-BRIEF.md, STEP6-REPORT.md, the
step-6 diff (jtobkin/suprafx TS + suprafx-agent-sdk). Write `docs/lockrel/STEP6-AUDIT-<you>.md`: PASS/FAIL,
numbered defects (severity, file:line, repro), then "unverified hypotheses". Under 2 pages.

1. **Chain truth wins.** No projector path re-derives settlement math; statuses come from chain events
   (`OrderMaintenance`, accept, cancel) or the chain-truth snapshot; `list_my_open_orders` keeps the chain
   `locked_in_*` filter. Any place the mirror could show a lock the chain has released (or vice versa) = defect.
2. **A' gate.** `projectCancelRfq`, auto-fire, manual accept, and the new `projectOrderMaintenance` each reject
   sibling quotes by id; run the projector tests and write one yourself for a mixed pending/review sibling set.
3. **Enum/migration safety.** New status values (`expired`, `unfillable`, triggers) are additive; any CHECK
   constraint migration keeps existing rows valid; the migration is idempotent and has a rollback.
4. **Pre-check (rule 3).** Each refusal fires BEFORE the envelope is forwarded (no lock, no sequence burn);
   the bucket-full retry picks the next open height and cannot loop forever; messages are plain English.
5. **SDK.** V2 encoding vectors equal the Rust vectors from step 4 (byte-for-byte); `expires_in_batches` bounds
   match the chain constants; old SDK versions still work (V1 path untouched); docs say expiry is in blocks.
6. **No consensus code changed** in this step (diff must not touch `council-rust/crates/protocol`).
7. **Run yourself:** vitest suites named in the report, `npm test` in the SDK, and any Playwright step; compare
   with the report.
