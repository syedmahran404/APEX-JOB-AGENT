# `infra/k8s`

Helm chart `apex-job-agent` and per-environment values.

Phase reference: [Phase 9 §4–§7](../../docs/architecture/09-deployment-architecture.md#4-kubernetes-topology-hosted-prod).

Layout:

```
chart/                       # The umbrella chart with subcharts per app
├── Chart.yaml
├── values.yaml              # Defaults (single-tenant safe)
├── templates/
└── README.md

envs/
├── staging.values.yaml
└── prod.values.yaml
```

The same chart deploys staging, prod, and (with `mode: selfhost`) a single-tenant cluster. Promotion = same image digests, different values.

Workload conventions:
- Workers live in a tainted `dedicated=automation:NoSchedule` node pool.
- HPA on stateless apps; KEDA on queue-driven workers; cluster autoscaler on the worker pool.
- `terminationGracePeriodSeconds: 300` for workers so in-flight applications complete cleanly on rollouts.
