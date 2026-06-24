export interface BundleModuleForNodeOptions {
  readonly external?: ReadonlyArray<string>;
  readonly prefix?: string;
  readonly tempRoot?: string;
}

export interface BundledNodeModule {
  readonly outfile: string;
  readonly cleanup: () => Promise<void>;
}

export declare const bundleModuleForNode: (
  entryPoint: string,
  options?: BundleModuleForNodeOptions,
) => Promise<BundledNodeModule>;

export declare const importBundledModule: (
  entryPoint: string,
  options?: BundleModuleForNodeOptions,
) => Promise<Record<string, unknown>>;
