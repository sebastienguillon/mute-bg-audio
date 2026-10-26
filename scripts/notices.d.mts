// Types of scripts/notices.mjs (imported by the unit tests).
import type { LookaheadModelName } from './models.mjs';

export interface InstalledPackage {
  name: string;
  version: string;
  /** Real path of the package directory. */
  dir: string;
}

export declare const ROOT: string;
/** The notices file of the default build, relative to the repository root. */
export declare const NOTICES: string;

/** The npm packages whose code is in the package. */
export declare function bundledPackages(root?: string): InstalledPackage[];
/** Downloads the texts of vendor/onnxruntime-web and vendor/wxt for the installed versions. */
export declare function fetchVendorTexts(root?: string): Promise<void>;
/** Rewrites vendor/deepfilternet/crates.json and notices/ from a patched DeepFilterNet checkout. */
export declare function refreshCrates(checkout: string, root?: string): void;
/** The notices file of the build with this look-ahead model (default 'kim'), relative to the repository root. */
export declare function noticesFile(model?: LookaheadModelName): string;
/** The notices of the build with this look-ahead model (default 'kim'), with a UTF-8 BOM. */
export declare function renderNotices(root?: string, model?: LookaheadModelName): string;
