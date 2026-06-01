// @apex/realtime — Socket.IO server with mandatory Redis adapter and the
// project's topic conventions.
//
// Reference: docs/audit/01-architecture-validation.md §B3.

export {
  createRealtimeServer,
  type RealtimeServer,
  type RealtimeServerOptions,
} from './server.js';
