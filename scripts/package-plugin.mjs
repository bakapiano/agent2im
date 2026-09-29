import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Build the artifact with the same Node platform/ABI as the included native addon.
if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  Number(process.versions.node.split('.')[0]) !== 24
) {
  throw new Error('Build the Windows x64 plugin with Node 24.');
}
const root = resolve('.');
const info = JSON.parse(readFileSync(join(root, 'dist/build.json'), 'utf8'));
const output = resolve(process.argv[2] ?? `dist/plugins/${info.buildId}/agent-to-im`);
if (existsSync(output)) {
  throw new Error('Plugin output already exists; choose a fresh build directory.');
}
mkdirSync(output, { recursive: true });
cpSync(join(root, 'plugins/codex/agent-to-im'), output, { recursive: true });
const runtime = join(output, 'runtime');
mkdirSync(join(runtime, 'dist'), { recursive: true });
cpSync(process.execPath, join(runtime, 'node.exe'));
cpSync(join(dirname(process.execPath), 'LICENSE'), join(runtime, 'NODE-LICENSE'));
writeFileSync(
  join(runtime, 'package.json'),
  JSON.stringify({ name: 'agent-to-im-runtime', private: true, type: 'module' }),
);

const result = await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(runtime, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  metafile: true,
  define: { __AGENT_IM_BUILD_ID__: JSON.stringify(info.buildId) },
  legalComments: 'linked',
});
cpSync(join(root, 'dist/web'), join(runtime, 'dist/web'), { recursive: true });

// Materialize the exact installed production graph into real directories. Resolution follows
// Node's nearest node_modules rule; duplicate versions get a private nested copy. The artifact
// has no links back into the checkout, package-manager store, or user's filesystem.
const placed = new Map();
const queue = [];

function packageSource(from, name, optional = false) {
  const resolver = createRequire(join(from, 'package.json'));
  for (const folder of resolver.resolve.paths(name) ?? []) {
    const file = join(folder, name, 'package.json');
    if (existsSync(file)) {
      return realpathSync(dirname(file));
    }
  }
  if (optional) {
    return undefined;
  }
  throw new Error(`Missing production dependency: ${name}`);
}

function reserve(source, destination) {
  const old = placed.get(destination);
  if (old) {
    if (old !== source) {
      throw new Error(`Dependency collision at ${destination}`);
    }
    return;
  }
  placed.set(destination, source);
  queue.push({ source, destination });
}

function inherited(parent, name) {
  let current = parent;
  while (true) {
    const candidate = join(current, 'node_modules', name);
    if (placed.has(candidate)) {
      return { path: candidate, source: placed.get(candidate) };
    }
    if (current === runtime) {
      return undefined;
    }
    const next = dirname(current);
    if (
      next === current ||
      (next !== runtime && !relative(runtime, next).startsWith('node_modules'))
    ) {
      return undefined;
    }
    current = next;
  }
}

const roots = new Set();
for (const compiled of Object.values(result.metafile.outputs)) {
  for (const dependency of compiled.imports) {
    if (!dependency.external || isBuiltin(dependency.path)) {
      continue;
    }
    roots.add(
      dependency.path.startsWith('@')
        ? dependency.path.split('/').slice(0, 2).join('/')
        : dependency.path.split('/')[0],
    );
  }
}
for (const name of roots) {
  reserve(packageSource(root, name), join(runtime, 'node_modules', name));
}
for (const { source, destination } of queue) {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === source || !relative(source, path).split(/[\\/]/).includes('node_modules'),
  });
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    const dependency = packageSource(
      source,
      name,
      Object.hasOwn(pkg.optionalDependencies ?? {}, name),
    );
    if (!dependency) {
      continue;
    }
    const existing = inherited(destination, name);
    if (existing?.source === dependency) {
      continue;
    }
    reserve(
      dependency,
      existing ? join(destination, 'node_modules', name) : join(runtime, 'node_modules', name),
    );
  }
}
const executable = join(runtime, 'node.exe');
const cli = join(runtime, 'dist/cli.js');
const version = JSON.parse(
  execFileSync(executable, [cli, 'version'], { cwd: output, encoding: 'utf8', windowsHide: true }),
);
if (version.buildId !== info.buildId) {
  throw new Error('Packaged runtime build mismatch.');
}
const checkSqlite =
  'const D=require("better-sqlite3");const d=new D(":memory:");d.exec("select 1");d.close();';
execFileSync(executable, ['-e', checkSqlite], { cwd: runtime, windowsHide: true });
writeFileSync(
  join(output, 'build.json'),
  JSON.stringify(
    {
      ...info,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      packages: placed.size,
      pluginCliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    plugin: output,
    buildId: info.buildId,
    node: process.version,
    packages: placed.size,
  }),
);
