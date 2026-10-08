import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, Context } from './context.js';

export const DEFAULT_EXAMPLES_REPO = 'https://github.com/getdokan/flycommerce-app-examples.git';
export const DEFAULT_TEMPLATE = 'order-export';

export interface InitOptions {
  directory?: string;
  template?: string;
  repo?: string;
}

export function writeStarterApp(targetDir: string, appName: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const appConfig = {
    $schema: 'https://cdn.flycommerce.com/schemas/app-config.v1.json',
    name: appName,
    appUrl: 'http://localhost:3000',
    installRedirect: '/auth/callback',
    scopes: ['orders.read'],
    pages: [
      {
        label: appName,
        slug: 'main',
        path: '/',
      },
    ],
  };

  const packageJson = {
    name: appName.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'node server.js',
      build: 'tsc',
    },
    dependencies: {
      '@flycommerce/app-bridge': '^0.1.0',
      '@flycommerce/app-server': '^0.1.0',
    },
  };

  const serverJs = `import http from 'node:http';
import { createAppServer, loadAppConfig } from '@flycommerce/app-server';

const config = loadAppConfig();
const app = createAppServer({ config });

const server = http.createServer((req, res) => {
  if (app.handle(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Welcome to ' + config.name + '</h1>');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('App listening on port ' + port);
});
`;

  fs.writeFileSync(path.join(targetDir, 'app-config.json'), JSON.stringify(appConfig, null, 2) + '\n');
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
  fs.writeFileSync(path.join(targetDir, 'server.js'), serverJs);
  fs.writeFileSync(path.join(targetDir, '.gitignore'), 'node_modules\n.env\ndist\ncredentials.json\n');
}

export async function initApp(ctx: Context, options: InitOptions): Promise<void> {
  const targetDir = path.resolve(ctx.cwd, options.directory ?? '.');
  const appName = path.basename(targetDir) === '.' ? 'my-flycommerce-app' : path.basename(targetDir);
  const template = options.template ?? DEFAULT_TEMPLATE;
  const repoUrl = options.repo ?? DEFAULT_EXAMPLES_REPO;

  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir).filter((f) => !f.startsWith('.git'));
    if (files.length > 0) {
      throw new CliError(`Directory "${targetDir}" is not empty. Choose an empty directory or specify a new directory name.`);
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  ctx.stdout(`Creating a new FlyCommerce app in ${targetDir}...`);

  let clonedFromRepo = false;

  // Try to clone example from repository if git is installed
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycom-template-'));
    try {
      execFileSync('git', ['clone', '--depth', '1', repoUrl, tempDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const templatePath = path.join(tempDir, template);
      if (fs.existsSync(templatePath)) {
        fs.cpSync(templatePath, targetDir, { recursive: true });
        clonedFromRepo = true;
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Git clone failed or not available; fall back to built-in starter
  }

  if (!clonedFromRepo) {
    writeStarterApp(targetDir, appName);
  }

  // Update package.json name if present
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.name = appName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch {}
  }

  // Update app-config.json if present
  const configPath = path.join(targetDir, 'app-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.name !== undefined) {
        config.name = appName;
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    } catch {}
  }

  ctx.stdout(`\nSuccess! Created ${appName} at ${targetDir}`);
  ctx.stdout(`\nInside that directory, you can run:`);
  ctx.stdout(`  npm install`);
  ctx.stdout(`  flycommerce app dev\n`);
}
