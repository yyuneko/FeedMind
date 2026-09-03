import { googleReaderConnector } from "./google-reader";
import type { ConnectorType, SourceConnector } from "./types";

export type * from "./types";

export function connectorFor(type: ConnectorType): SourceConnector {
  if (type === "google_reader") return googleReaderConnector;
  throw new Error(`connector_not_syncable:${type}`);
}
