# `infra/otel`

OpenTelemetry collector configuration, Grafana dashboards, and Alertmanager rules.

Phase reference: [Phase 9 §9](../../docs/architecture/09-deployment-architecture.md#9-observability).

Layout:

```
collector.yaml               # Pipelines: receivers (otlp) → processors → exporters (Tempo, Loki, Prom)
grafana/
├── dashboards/              # System, Runs, AI, Adapters, Security, Costs (versioned JSON)
└── datasources/             # Tempo, Loki, Prometheus
alerts/                      # Alertmanager rules + routing
```

Every alert in `alerts/` has a runbook entry under [`docs/runbooks/`](../../docs/runbooks).
