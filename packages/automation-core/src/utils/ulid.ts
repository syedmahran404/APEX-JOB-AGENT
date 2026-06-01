// Thin re-export wrapper. Centralized so ULID dependency choice is one import
// site for the whole engine.

import { ulid } from 'ulid';

export function newUlid(): string {
  return ulid();
}
