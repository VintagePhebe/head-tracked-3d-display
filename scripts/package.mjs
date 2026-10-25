// Packages the application into a standalone Windows folder under release/ using @electron/packager.
import packager from '@electron/packager';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const paths = await packager({
  dir: root,
  out: join(root, 'release'),
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  executableName: 'VirtualWindow',
  ignore: [
    /^\/src($|\/)/,
    /^\/tests($|\/)/,
    /^\/public($|\/)/,
    /^\/scripts($|\/)/,
    /^\/release($|\/)/,
    /^\/\.git($|\/)/,
  ],
});
console.log('[package] Built desktop package at:', paths.join(', '));
