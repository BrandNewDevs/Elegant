/** The two kinds of model the engine downloads: the one that turns speech into text, and the one that tells speakers apart. */
export const MODEL_KINDS = ["speech", "speaker"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** One kind of model as it is on disk. */
export interface ModelFile {
  kind: ModelKind;
  /** Whether it is on disk now. */
  present: boolean;
  /** How much space it takes; 0 when it is not present. */
  bytes: number;
}
