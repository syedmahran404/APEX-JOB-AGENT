# `@apex/shared-errors`

Typed error hierarchy. The only place in the codebase allowed to subclass `Error`.

Reference: [Phase 4 §3.6](../../docs/architecture/04-backend-design.md#36-error-model).

```
ApexError
├── ValidationError          (400)
├── AuthError
│   ├── UnauthenticatedError (401)
│   ├── MfaRequiredError     (401, code: mfa_required)
│   └── ForbiddenError       (403)
├── NotFoundError            (404)
├── ConflictError            (409)
├── PreconditionFailedError  (412)
├── RateLimitedError         (429)
├── DependencyError          (502)
└── InternalError            (500)
```

Every error carries `code`, `message`, `traceId`, optional typed `details`. Throwing raw `Error` outside this package is blocked by `apex/error-class-from-shared-errors`.
