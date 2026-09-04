import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

/**
 * Packages resolved from node_modules at runtime instead of being bundled by
 * Vite. Everything else in node_modules is dev-only or already inlined into
 * the .vite bundles, so the packaged app carries only these and their
 * production dependency closure (~350 MB, almost all ONNX Runtime).
 */
const RUNTIME_PACKAGES = ['@huggingface/transformers'];

/**
 * Parts of the runtime closure that are never loaded on this target:
 * ONNX Runtime binaries for other platforms, and onnxruntime-web (the
 * WASM/WebGPU backend; the Node build of Transformers.js requires only
 * onnxruntime-node and sharp). Together ~150 MB.
 */
const RUNTIME_EXCLUDES = [
  // Keeps the `win32` and `win32/x64` directories themselves (the copy walks
  // parents first) and drops every other platform.
  /^\/node_modules\/onnxruntime-node\/bin\/napi-v3\/(?!win32(\/x64(\/|$)|$))/,
  /^\/node_modules\/onnxruntime-web(\/|$)/,
  /\.map$/,
];

/** Packages whose native binaries load sibling DLLs, so the whole package
 *  directory must live outside the asar (auto-unpack-natives only extracts
 *  the `.node` file itself). */
const UNPACKED_PACKAGES = ['onnxruntime-node', 'sharp', '@img'];

/**
 * Walks package.json `dependencies` + `optionalDependencies` from the runtime
 * packages, honouring nested node_modules, and returns the asar-relative
 * directories (e.g. `/node_modules/onnxruntime-node`) that must be packaged.
 */
function runtimeClosure(rootDir: string): Set<string> {
  // Forge's config loader hands over a forward-slash __dirname on Windows;
  // resolve so prefix checks agree with path.join output.
  const projectDir = path.resolve(rootDir);
  const keep = new Set<string>();
  const visit = (pkgDir: string) => {
    const rel = `/${path.relative(projectDir, pkgDir).split(path.sep).join('/')}`;
    if (keep.has(rel)) return;
    keep.add(rel);
    const pj = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })) {
      if (dep.startsWith('@types/')) continue; // type-only, never loaded at runtime
      // Nested first (npm dedupe), then hoisted; optional platform packages
      // for other OSes are simply not installed.
      let dir: string = pkgDir;
      let found: string | null = null;
      while (true) {
        const candidate = path.join(dir, 'node_modules', dep);
        if (existsSync(path.join(candidate, 'package.json'))) {
          found = candidate;
          break;
        }
        if (path.resolve(dir) === path.resolve(projectDir)) break;
        dir = path.dirname(dir);
        if (!dir.startsWith(projectDir)) break;
      }
      if (found) visit(found);
    }
  };
  for (const name of RUNTIME_PACKAGES) visit(path.join(projectDir, 'node_modules', name));
  return keep;
}

const packaged = runtimeClosure(__dirname);

const config: ForgeConfig = {
  packagerConfig: {
    name: 'CueDeck',
    executableName: 'cuedeck',
    icon: './assets/icon',
    // The packager's own node_modules pruner would bypass the `ignore`
    // allowlist below for module directories; the allowlist is stricter.
    prune: false,
    asar: {
      unpack: `**/node_modules/{${UNPACKED_PACKAGES.join(',')}}/**`,
    },
    // The Forge Vite plugin's default ignore keeps only `.vite/`, which drops
    // the runtime packages above (the STT worker `import()`s Transformers.js
    // from node_modules). This allowlist keeps the Vite output, package.json
    // and exactly the runtime closure; source maps stay out of releases.
    ignore: (file: string): boolean => {
      if (!file) return false;
      if (file === '/package.json') return false;
      if (file.startsWith('/.vite')) return file.endsWith('.map');
      if (file === '/node_modules') return false;
      if (file.startsWith('/node_modules/')) {
        if (RUNTIME_EXCLUDES.some((re) => re.test(file))) return true;
        for (const dir of packaged) {
          if (file === dir || file.startsWith(`${dir}/`) || dir.startsWith(`${file}/`)) {
            return false;
          }
        }
      }
      return true;
    },
    // No signing identity: releases are unsigned; checksums are published
    // instead (spec §5.6 release finding).
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'cuedeck',
      setupExe: 'CueDeck-Setup.exe',
      setupIcon: './assets/icon.ico',
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/main/workers/sttWorker.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Electron fuses (spec §17.15): disable Node escape hatches in the
    // packaged binary.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
