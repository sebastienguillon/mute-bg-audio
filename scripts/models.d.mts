// Types of scripts/models.mjs (imported by wxt.config.ts).

export interface ModelSource {
  url: string;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  /** Packaged with the extension (public/models); the others are for comparison tests only. */
  packaged: boolean;
}

export declare const MODELS: {
  readonly 'Kim_Vocal_2.onnx': ModelSource;
  readonly 'UVR-MDX-NET-Voc_FT.onnx': ModelSource;
};

/** SHA-256 (hex) of a file, streamed. */
export declare function sha256File(path: string): Promise<string>;
