/**
 * `@retick/client/legacy`: the Agora reader, for Exo's Mesa.
 *
 * It reads the Agora bridge, whose wire format and snapshot are Portuguese and
 * frozen (contract-map.csv, option O2). In 0.3.0 the same reader is still
 * exported from the package root, deprecated, so nothing that imports it from
 * 0.2.0 breaks. This entry point is where it stays after the root drops it
 * (proposed for the first minor after Exo moves to `createStateReader`).
 *
 * New code reads state with `createStateReader` from `@retick/client`.
 * To be ready for the removal, change only the import path:
 *
 *   import { createAgoraReader } from '@retick/client/legacy'
 */

export { AGORA_ROUTES, createAgoraReader } from './agora.ts'
export type {
  AgoraReader,
  AgoraReaderOptions,
  AgoraSnapshot,
  Credentials,
  Freshness,
  ReaderStatus,
  RevocationOutcome,
} from './agora.ts'
