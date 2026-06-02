// ZodPipe — per-endpoint Zod validation pipe.
// Used as: `@Body(new ZodPipe(SchemaXyz)) dto: z.infer<typeof SchemaXyz>`.
//
// The pipe takes a single Zod schema and validates the bound argument. On
// failure it throws a typed ValidationError that the global ApexErrorFilter
// converts to the standard envelope (400 + machine-readable issues).

import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '@apex/shared-errors';

@Injectable()
export class ZodPipe<TSchema extends ZodSchema> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): unknown {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw mapZodError(parsed.error);
  }
}

function mapZodError(err: ZodError): ValidationError {
  const issues = err.issues.map((i) => ({
    path: i.path,
    message: i.message,
    code: i.code,
  }));
  return new ValidationError('Invalid request', issues);
}
