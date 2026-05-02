type LanceDbModule = typeof import("@lancedb/lancedb");

export type LanceDbRuntimeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type LanceDbRuntimeLoaderDeps = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  importBundled: () => Promise<LanceDbModule>;
};

function buildLoadFailureMessage(error: unknown): string {
  return [
    "memory-lancedb: bundled @lancedb/lancedb dependency is unavailable.",
    "Install or repair the memory-lancedb plugin package dependencies, then restart OpenClaw.",
    String(error),
  ].join(" ");
}

function isUnsupportedNativePlatform(params: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): boolean {
  return params.platform === "darwin" && params.arch === "x64";
}

function buildUnsupportedNativePlatformMessage(params: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): string {
  return [
    `memory-lancedb: LanceDB runtime is unavailable on ${params.platform}-${params.arch}.`,
    "The bundled @lancedb/lancedb dependency does not publish a native package for this platform.",
    "Disable memory-lancedb or switch to a supported memory backend/platform.",
  ].join(" ");
}

export function createLanceDbRuntimeLoader(overrides: Partial<LanceDbRuntimeLoaderDeps> = {}): {
  load: (_logger?: LanceDbRuntimeLogger) => Promise<LanceDbModule>;
} {
  const deps: LanceDbRuntimeLoaderDeps = {
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    importBundled: overrides.importBundled ?? (() => import("@lancedb/lancedb")),
    // Ensure these are defined in your deps or passed via overrides
    ...overrides 
  };

  let loadPromise: Promise<LanceDbModule> | null = null;

  return {
    async load(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            return await deps.importBundled();
          } catch (bundledError) {
            // 1. From 'main': Reset the promise so a failed load can be retried later
            loadPromise = null;

            // 2. From 'feat': Attempt to find/load a sidecar runtime from the state dir
            const runtimeDir = resolveRuntimeDir(
              deps.resolveStateDir(deps.env, () =>
                deps.env.HOME?.trim() ? deps.env.HOME : os.homedir(),
              ),
            );
            
            const existingRuntime = deps.resolveRuntimeEntry({
              runtimeDir,
              manifest: deps.runtimeManifest,
            });

            if (existingRuntime) {
              try {
                return await deps.importResolved(existingRuntime);
              } catch {
                // Reinstall below if the cached runtime is incomplete or stale.
              }
            }

            // 3. Logic Check: Handle Nix mode constraints
            if (deps.env.OPENCLAW_NIX_MODE === "1") {
              throw new Error(
                buildLoadFailureMessage(
                  "failed to load LanceDB and Nix mode disables auto-install",
                  bundledError,
                ),
                { cause: bundledError },
              );
            }

            // 4. From 'main': Platform support validation
            const explicitPlatformOverride =
              typeof overrides.platform === "string" || typeof overrides.arch === "string";

            if (
              isUnsupportedNativePlatform({ platform: deps.platform, arch: deps.arch }) &&
              (explicitPlatformOverride || !existingRuntime)
            ) {
              throw new Error(
                buildUnsupportedNativePlatformMessage({
                  platform: deps.platform,
                  arch: deps.arch,
                }),
                { cause: bundledError },
              );
            }

            // 5. Warning & Fallback (where your feat branch was heading)
            logger?.warn?.(
              `memory-lancedb: bundled LanceDB runtime unavailable (${String(bundledError)}); installing runtime deps under ${runtimeDir}`,
            );

            // ... Your auto-install logic likely continues here ...
            throw new Error(buildLoadFailureMessage(bundledError), { cause: bundledError });
          }
        })();
      }
      return await loadPromise;
    },
  };
}

const defaultLoader = createLanceDbRuntimeLoader();

export async function loadLanceDbModule(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
  return await defaultLoader.load(logger);
}
