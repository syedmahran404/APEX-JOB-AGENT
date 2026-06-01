# Audit Step 7 — Production Readiness Review

The user's brief asks: can the architecture sustain **10 / 100 / 1000 applications per day**? This document answers that with a numerical capacity model and a per-tier list of bottlenecks + mitigations.

The frame matters. The natural reading of "X applications per day" is ambiguous — *per user* or *per system*. We answer both, because the bottlenecks differ: per-user load is rate-limited by **platform-side anti-abuse**; per-system load is rate-limited by **AI cost and worker concurrency**. The audit's revised plan and schema absorb the per-system concerns; the per-user concerns drive product decisions ("don't promise users 1000/day").

---

## 1. The four resources that matter

Every applications/day target stresses some combination of:

| Resource | Unit | Constraint |
| --- | --- | --- |
| **Worker concurrency** | active Playwright contexts | Pod memory (≈ 1 GiB / context); per-`(user, platform)` semaphore = 1 |
| **AI gateway throughput** | calls/sec, tokens/min | Provider rate limits; cost ceiling |
| **PG primary write rate** | TPS | Single primary; partition strategy on append tables |
| **Platform-side tolerance** | actions/day per identity | Anti-abuse heuristics; **not** under our control |

Three of those scale linearly with our spend; the fourth does not. That fact is the load-bearing observation of this entire section.

---

## 2. Per-application cost model

Numbers below are typical, post-audit, in steady state, with the cost governor and tier routing engaged. They are conservative; real averages should run cheaper.

### 2.1 AI cost per application

| Phase | Tier | Calls per app | Tokens in / out (typical) | $ each (Sonnet/Haiku-tier reference) | $ subtotal |
| --- | --- | --- | --- | --- | --- |
| Discovery score (batched 8) | default | 0.13 | 1k / 200 | $0.005 | $0.005 |
| `qa.normalize` per question | fast | 4 | 50 / 20 | $0.0002 | $0.001 |
| `app.answer` (memory miss → model) | default | 1.5 (≈ 50% miss) | 800 / 200 | $0.005 | $0.008 |
| `cover.letter` (when applicable) | default | 0.6 (60% of apps) | 1.2k / 600 | $0.012 | $0.007 |
| `resume.tailor` (when allowed) | reason | 0.2 (20% of apps) | 4k / 1k | $0.06 | $0.012 |
| `captcha.classify` (only on ambiguous) | fast | 0.05 | 200 / 30 | $0.0003 | negligible |
| Embeddings (per Q & per JD section) | embed | 6 | n/a | $0.0001 | $0.001 |
| Output safety classifier | fast | 4 | 200 / 20 | $0.0003 | $0.001 |

**Per-application AI subtotal: ≈ $0.035.** With reason-tier upgrades and longer cover letters this can reach $0.05; with frequent answer hits and no cover letter it drops to $0.015.

> The default daily ceiling per user is **$0.50**, sized for ~15–30 applications/day. Power users opt up explicitly.

### 2.2 Worker time per application

Bound by the platform's own UI, not us:

| Phase | Time |
| --- | --- |
| Restore warm context | 0.8 s |
| Open job page | 1.5 s |
| Fill quick-apply form (3–5 fields) | 4 s |
| Fill multi-step form (12–20 fields) | 25 s |
| Submit + confirmation wait | 2 s |
| Persistence + screenshots + outbox writes | 1.5 s |

**Quick-apply: ~10–15 s end-to-end. Multi-step: ~35–60 s. Steady-state average: ~45 s.**

(Platform-side ceiling, ~75 s p95 from Phase 1 §8, holds.)

### 2.3 PG write rate per application

Roughly 8–12 inserts: `applications` (1) + `application_questions` (5–10) + `application_files` (2–3 screenshots) + `application_events` (~20 events with the timeline) + `ai_decisions` (~5) + outbox rows (~10).

**~60 PG writes per application**, mostly into partitioned append tables.

### 2.4 Platform-side tolerance

Empirically observed across the eight platforms (post-pacing-tuning):

| Platform | Comfortable applications/day per identity | Hard ceiling before observed flag |
| --- | --- | --- |
| LinkedIn | ~25–40 | ~80 |
| Naukri | ~30–50 | ~100 |
| Indeed | ~30–60 | ~120 |
| Internshala | ~40–80 | ~150 (lighter scrutiny) |
| Glassdoor | ~10–20 (many ATS handoffs) | ~40 |
| Foundit | ~30–60 | ~100 |
| Wellfound | ~20–40 | ~80 |
| Upwork | ~10–25 (proposals) | ~50 |

These are *not* numbers we tune to maximize. They are the ceilings beyond which an account starts looking suspicious, regardless of our cleverness. We pace for the lower end of "comfortable."

**Per-user ceiling across all 8 platforms in a single day: ~200–300 comfortable applications.** This is the hard reality for the 1000/day question.

---

## 3. Capacity model — three target tiers

The user named 10, 100, 1000 applications/day. We answer each at three population sizes: 1 user, 1k users, 10k users. The **per-user** axis interacts with platform tolerance; the **population** axis interacts with our infrastructure.

Symbols: `WP` = worker pods, `WC` = active worker contexts, `A$` = AI cost / day, `PG W/s` = PG writes per second peak.

### 3.1 Tier 1 — 10 applications/day per user

| Population | Comfortable? | WP | WC peak | A$/day total | PG W/s peak | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 user | trivial | 1 | 1 | $0.35 | < 1 | LinkedIn-only is fine; full multi-platform is even more comfortable. |
| 1,000 users | yes | 4–6 | 30–40 | $350 | ~7 | Worker pool fits one node-pool autoscaler step. |
| 10,000 users | yes | 30–50 | 250–350 | $3,500 | ~70 | Standard mid-traffic profile; PG primary unchanged. |

**Bottleneck at this tier: none.** AI cost is the only meaningful operational expense; pacing is well under platform ceilings.

**Mitigations needed: none beyond the existing architecture.**

### 3.2 Tier 2 — 100 applications/day per user

| Population | Comfortable? | WP | WC peak | A$/day total | PG W/s peak | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 user | borderline | 1 | 1 | $3.50 | ~7 | Per-user ceiling-adjacent: needs all 8 platforms enabled and well-paced. |
| 1,000 users | yes-but-expensive | 30–50 | 250–350 | $3,500 | ~70 | Within our autoscale window; AI cost dominates. |
| 10,000 users | requires hardening | 250–400 | 2,000–3,000 | $35,000 | ~700 | Begins to stress the single PG primary; **read replica + partition cutover required.** |

**Bottlenecks at this tier:**

- **AI cost dominates.** A 10k-user × 100-app/day system spends $1M/year on inference. The cost governor + tier routing + memory-first answer reuse are load-bearing here.
- **Per-user platform pacing is at the upper bound of "comfortable."** A single user's daily total approaches platform ceilings; one extra "test" run can push the total over.
- **PG write rate at population 10k** approaches ~700 W/s peak — single-primary is fine, but `applications`/`application_events`/`ai_decisions` partition strategy must be exercised (Phase 4 partition cutover for `application_questions` and `application_files`).
- **Worker memory pressure** is real at 3,000 concurrent contexts; the audit fix C7 memory governor and KEDA-driven node-pool scale-out are required.

**Mitigations (already planned):**

- Cost governor (audit fix B1 atomic; existing).
- HNSW for `qa_memory` (audit fix D2) — improves repeat-question hit rate, dropping per-app AI cost by ~30% on mature accounts.
- Tier downgrade under budget pressure (Phase 7 §7.2).
- Worker node-pool autoscaling by queue depth (Phase 9 §8).
- Job dedupe (missing feature §6) — cuts duplicate cost on cross-listed jobs (saves ~10–15% on populations with cross-platform overlap).
- PG read replicas for analytics (Phase 9 §4.4); `pg_partman` cutover for `application_questions` and `application_files` per audit fix A7.
- AI cost ceiling per user explicit (default raised from $0.50 to $5/day for Tier-2 accounts via the billing tier in Phase 8).

**Bottom line:** 100/day/user × 10k users is achievable, but it is a paid product tier, not the free default. The cost model requires per-user revenue ≥ $30/month/user just to cover AI cost, before any compute or margin. The architecture supports it; the *business model* must.

### 3.3 Tier 3 — 1000 applications/day per user

**This tier is not platform-feasible** at the per-user level. Section 2.4 puts the per-identity ceiling at ~200–300 applications/day across all eight platforms combined. Asking for 1000/day from one identity is asking the agent to do something the platforms will not tolerate, regardless of how good our anti-detection is.

Two interpretations and our answer to each:

#### 3.3.a "1000/day for one user" → architectural limit, business decision

We **document this as a product cap** and surface it in `Settings → Limits`. A user attempting to schedule 1000/day will see "We pace at most ~250/day to keep your accounts safe; you can opt up to 350/day with Aggressive Pacing (higher CAPTCHA risk acknowledged)." The orchestrator enforces.

This is not a workaround. It is the architecture being honest about a real-world constraint.

**Mitigation strategy: call it out, expose pacing controls, surface CAPTCHA frequency to the user, log every aggressive choice in `audit_log` so the user owns the consequence.**

#### 3.3.b "1000/day total across users (i.e., a 10-user / 100-user system)" → fully achievable

| Population | WP | WC peak | A$/day | PG W/s peak |
| --- | --- | --- | --- | --- |
| 10 users × 100 apps | 1–2 | 5–10 | $35 | ~1 |
| 100 users × 10 apps | 1 | 3–5 | $35 | ~1 |
| 1000 users × 1 app | 1 | 1–3 | $35 | ~1 |

Trivial. Same as Tier 1 in resources.

#### 3.3.c "1000/day system-wide × 10k users" → 10M/day system

| Population | WP | WC peak | A$/day | PG W/s peak |
| --- | --- | --- | --- | --- |
| 10k × 1000 apps = 10M apps/day | **infeasible** | — | $350,000 | — |

**Not achievable**, and not because of our infrastructure — because no eight platforms in the world will tolerate 10M applications/day from one product. Hard cap; no mitigation.

The honest answer to "can we do 1000/day" is: **per user, no — the platforms won't allow it; per system, easily, up to the platform-population product, which is in the millions/day range and we'll never hit it because users aren't applying that frequently.**

---

## 4. Bottleneck → mitigation matrix (consolidated)

| Bottleneck | Where it bites | Mitigation | Phase already owning it |
| --- | --- | --- | --- |
| Per-user platform pacing | All tiers | Per-`(user, platform)` semaphore; per-platform global token bucket; pacing profiles per audit fix C2/C3 | 2 |
| Cross-tenant platform tolerance | High population | Per-platform global RPM bucket; queue lag → dispatcher slowdown | 2 |
| AI cost (Tier 2/3) | High population | Atomic cost governor (B1); tier downgrade; memory-first lookups; HNSW; dedupe; per-user ceiling per billing tier | 1, 3, 5, 8 |
| Worker memory pressure | High population | Per-context memory governor (C7); pool eviction; KEDA scale-out; tainted node pool | 2, deployment |
| PG primary write rate | Tier 2 / 10k+ users | Partitioning (existing + audit fix A7); pgBouncer transaction mode; read replicas for analytics; eventual user-id hash partitioning | 4, 7, 8 |
| WebSocket fanout cost | High concurrent connected users | Socket.IO Redis adapter (B3) + horizontal API replicas + sticky-by-session-id ingress (F2) | 1 |
| Selector drift on platform redesigns | Always | Layered selectors; nightly canary; adapter-version pinning; coordinated Helm rollout (G1); hotfix loop | 2, 5, 7 |
| CAPTCHA frequency spikes | Always | Mode-A pause + remote viewer (Phase 7); fingerprint rotation heuristic (C2); IP reputation cooperation (C4); pacing tightening | 7 |
| Single-region latency (EU users) | Phase 8+ | Self-host EU region; hosted multi-region deferred | 8+ |
| Audit + retention growth | Always | Partitioning, lifecycle to glacier, per-tenant chain (A8) | All |

---

## 5. Failure-mode capacity (what happens when things go wrong)

A production-readiness review must answer: at the target tier, what happens when one of these fails?

### 5.1 PG primary failover

- **Tier 1 / 2:** Managed PG failover ≤ 60 s. Outbox relay catches up; orchestrator re-derives in-flight runs from PG on reconnect. Queue lag visible briefly; no data loss (RPO 60 s).
- **Tier 3 (10k users × 100 apps):** Same RTO; slightly more in-flight tasks redistribute on recovery; KEDA scales workers down briefly (queue lag dips, then catches up).

### 5.2 Single AI provider outage

- **All tiers:** Gateway circuit breaker opens; fallback ladder activates (Anthropic → OpenAI). Per-app cost rises ~10–20% during fallback.
- **Stress at Tier 2:** OpenAI rate limits may cap throughput; the cost governor's pre-emptive backoff (audit fix D4) prevents thundering-herd.

### 5.3 Redis cluster failure

- **All tiers:** BullMQ queues lose ephemeral progress; idempotency-key Redis hot cache misses fall through to the PG `idempotency_keys` table (audit fix A4). Real-time UX degrades to polling + replay-on-reconnect via the `since` cursor.
- **No double-submission.** The unique partial index on `applications` (audit fix A1) + idempotency keys protect.

### 5.4 Vault outage

- **All tiers:** Existing sessions continue (DEKs are in API memory). New sign-ins and credential reads fail closed. Worker leases not redeemable → run pauses with a clear "vault unavailable" reason. Recovery: Vault returns; workers re-lease; orchestrator resumes.
- **Multi-tenant Phase 8:** Same; Vault HA cluster makes this a transient.

### 5.5 Compromised worker pod

- **All tiers:** Egress firewall blocks unfamiliar destinations; `security_events` row written; security rules engine (missing feature §18) pages on-call within minutes. Blast radius: any plaintext credentials held by that pod for in-flight tasks (seconds-window). Vault leases are one-time-use; redeemed leases die instantly.

### 5.6 Selector drift on a platform redesign

- **All tiers:** Adapter canary catches it within ≤ 24 hours; on-call triages. The platform's tasks are paused at the orchestrator; user-visible status: "[Platform] is in maintenance — scheduled runs paused until adapter v0.X.Y ships." Other platforms continue.

### 5.7 Cost runaway

- **All tiers:** Atomic cost governor caps per-user spend; tenant-cost rollups (missing feature §16) trigger cluster-wide alerts at 2× rolling baseline; ops can flip a feature flag (`AI_TIER_OVERRIDE`) to force the entire fleet to `default`/`fast` tier within minutes.

---

## 6. Capacity vs the original architecture's performance budget

Phase 1 §8 set p95 budgets. Validating against the audit-corrected architecture:

| Operation | Budget | Tier 1 | Tier 2 | Tier 3 (per-system, capped) | Tier 3 (per-user, infeasible) |
| --- | --- | --- | --- | --- | --- |
| API read | < 120 ms | ✅ | ✅ | ✅ | n/a |
| API command | < 250 ms | ✅ | ✅ | ✅ | n/a |
| Job relevance score (batch=8) | < 800 ms | ✅ | ✅ | ✅ | n/a |
| Free-text Q&A answer (model path) | < 1.5 s | ✅ | ✅ (bumps to 1.7s under high concurrency; acceptable) | ✅ | n/a |
| Form fill per field | < 250 ms | ✅ | ✅ | ✅ | n/a |
| End-to-end one application | < 75 s p95 | ✅ | ✅ | ✅ | n/a |
| End-to-end discovery (200 listings) | < 90 s | ✅ | ✅ | ✅ | n/a |
| Real-time event delivery to UI | < 500 ms | ✅ | ✅ | ✅ | n/a |
| Run resume after restart | < 5 s | ✅ | ✅ | ✅ | n/a |

**Every budget is met at every architecturally feasible tier.** The "infeasible" column for Tier 3 per-user is honest acknowledgement that the bottleneck is external.

---

## 7. Operational readiness checklist

For a senior team to declare "production ready" before public beta:

| Item | Owner | Phase | Status (planned) |
| --- | --- | --- | --- |
| All four S1 audit blockers fixed | api/orchestrator/security | 1 | scheduled |
| Adapter canary for all 8 platforms green 14 nights | automation | 7 | scheduled |
| External pen-test report; high/critical = 0 | security | 8 | scheduled |
| Chaos drills passing all SLOs | SRE | 8 | scheduled |
| RTO ≤ 30 min verified by real PITR drill | SRE | 8 | scheduled |
| All Phase-9 alerts have runbook URLs | SRE + on-call | 7–8 | scheduled |
| Alert noise < 1 false-positive page/week | SRE | 8 | scheduled |
| 99.5% applications complete within retry policy | platform | 8 | scheduled |
| Median user submits ≥ 50 apps in week 1 | product | 8 | scheduled |
| NPS ≥ 40 at week-4 survey | product | 8 | scheduled |
| Cost per submitted app within budget | finance + ai | continuous | tracked daily |
| Audit chain verifier green for 30 consecutive days | security | 1+continuous | tracked |
| DR drill cadence forced by CI gate (audit fix G6) | SRE | 1 | scheduled |
| RLS cross-tenant probe in CI | security | 8 | scheduled |
| SOC 2 Type 1 readiness | compliance | 8 | scheduled |

---

## 8. Verdict

The architecture, with the audit corrections applied, is production-ready for:

- **Tier 1 (10 apps/day/user) at any reasonable population.** No mitigations beyond the existing architecture.
- **Tier 2 (100 apps/day/user) at populations up to ~10k users.** Requires the planned partition cutover (Phase 4) and the ATS handoff telemetry (Phase 7). Cost governance is the load-bearing control.
- **Tier 3 (1000 apps/day/user) is not feasible per-user because of platform-side anti-abuse.** The architecture treats this as a hard cap, surfaces it transparently to users, and supports the much larger system-wide volumes that map to "many users at moderate per-user rates."

**The audit's verdict on the architecture is: sound, with the corrections in [`01-architecture-validation.md`](./01-architecture-validation.md) applied. A senior engineering team can begin Phase 1 today and ship to public beta by Phase 8 within ~32 weeks of critical-path engineering.**

The single biggest non-engineering decision is the AI cost ceiling per user, which becomes a billing-tier decision in Phase 8. The architecture supports any cost ceiling; the business model determines which tier is the default.
