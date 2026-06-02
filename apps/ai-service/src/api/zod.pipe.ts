// Per-endpoint Zod validation pipe (mirrors apps/api/src/infra/zod.pipe.ts).
import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, infer as ZodInfer } from 'zod';
import { ValidationError } from '@apex/shared-errors';

@Injectable()
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}
  transform(value: unknown): ZodInfer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        'Request validation failed',
        result.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
      );
    }
    return result.data as ZodInfer<S>;
  }
}
