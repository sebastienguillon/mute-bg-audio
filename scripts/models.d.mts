// Types of scripts/models.mjs (imported by wxt.config.ts and the tests).

export type LookaheadModelName = 'kim' | 'scnet';

export interface ModelSource {
  /** Download URL; null: the file is committed to the repository. */
  url: string | null;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  /** The build that packages it (public/models); null: for comparison tests only. */
  build: LookaheadModelName | null;
}

export declare const MODELS: {
  readonly 'Kim_Vocal_2.onnx': ModelSource;
  readonly 'UVR-MDX-NET-Voc_FT.onnx': ModelSource;
  readonly 'scnet_vocals.onnx': ModelSource;
};

export type ModelFile = keyof typeof MODELS;

/** Values of LOOKAHEAD_MODEL (the first is the default). */
export declare const LOOKAHEAD_MODELS: readonly LookaheadModelName[];

export interface LookaheadBuild {
  name: LookaheadModelName;
  /** The model file it packages. */
  file: ModelFile;
  /** Suffix of its output directory and zip: '' for the default build, else '-<name>'. */
  suffix: string;
}

/** The build LOOKAHEAD_MODEL selects (default: process.env.LOOKAHEAD_MODEL); throws for unknown values. */
export declare function lookaheadBuild(value?: string): LookaheadBuild;

/** SHA-256 (hex) of a file, streamed. */
export declare function sha256File(path: string): Promise<string>;
