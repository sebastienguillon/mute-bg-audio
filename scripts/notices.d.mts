// Types of scripts/notices.mjs (imported by the unit tests).

export interface InstalledPackage {
  name: string;
  version: string;
  /** Real path of the package directory. */
  dir: string;
}

export declare const ROOT: string;
/** The notices file, relative to the repository root. */
export declare const NOTICES: string;

/** The npm packages whose code is in the package. */
export declare function bundledPackages(root?: string): InstalledPackage[];
/** Downloads the texts of vendor/onnxruntime-web and vendor/wxt for the installed versions. */
export declare function fetchVendorTexts(root?: string): Promise<void>;
/** Rewrites vendor/deepfilternet/crates.json and notices/ from a patched DeepFilterNet checkout. */
export declare function refreshCrates(checkout: string, root?: string): void;
/** The notices file content (with a UTF-8 BOM). */
export declare function renderNotices(root?: string): string;
