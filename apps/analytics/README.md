# `apps/analytics` — Event ingest + rollups

Append-only ingest into `analytics_events` (partitioned monthly), plus rollup workers that maintain `analytics_rollups` for the dashboard.

Phase references:
- [Phase 1 §2.6](../../docs/architecture/01-system-architecture.md#26-analytics-service-appsanalytics)
- [Phase 3 §4.8](../../docs/architecture/03-database-design.md#48-audit--analytics)

Conventions:
- Reads are served from `analytics_rollups` and continuous aggregates, never from raw events at request time.
- All counts are scoped to `user_id`; cross-tenant aggregation is opt-in (M9+).
- The Operations dashboard pulls from this service for AI cost over time, validation failure rates, queue depths, and adapter version distribution.
