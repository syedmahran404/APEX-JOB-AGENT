# `infra/terraform`

Cloud infrastructure as code. Module-based; environment-scoped state.

Phase reference: [Phase 9 §4 / §10](../../docs/architecture/09-deployment-architecture.md#4-kubernetes-topology-hosted-prod).

Layout:

```
modules/                     # Reusable: vpc, eks/gke, rds (Postgres), redis, s3, kms, iam
envs/
├── staging/
└── prod/
```

State lives in a remote backend (S3 + DynamoDB lock or GCS + lock); no plaintext secrets in state. Module inputs accept Vault references, never raw values.
