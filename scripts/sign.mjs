// scripts/sign.mjs <Storm.app> <identity>: signs the app for distribution outside the App
// Store, with the hardened runtime Apple's notary service asks for. Every part of an Electron
// app is signed from the inside out; @electron/osx-sign knows the order.
//
// Storm asks for one entitlement, the one Electron cannot run without (its JavaScript engine
// writes code as it goes). The tool's own default for an app also asks for the camera, the
// microphone, Bluetooth and more, none of which Storm uses, so the default is not taken.
// Electron's helper processes keep the tool's defaults, which are already as small.
//
// Only code is signed file by file: programs and libraries. The tool would also sign every
// other binary file one at a time (each language's locale.pak, for one), which those files do
// not need, since the bundle they sit in seals them, and which fails now and then for want of
// a timestamp.
import fs from 'node:fs';
import { sign } from '@electron/osx-sign';

/** The first four bytes of a program or library (Mach-O, thin or universal, either byte order). */
const CODE = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);
/** True for a plain file that is not code. Folders (the bundles) are never passed over. */
function notCode(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    const fd = fs.openSync(file, 'r');
    const start = Buffer.alloc(4);
    fs.readSync(fd, start, 0, 4, 0);
    fs.closeSync(fd);
    return !CODE.has(start.toString('hex'));
  } catch {
    return false;
  }
}

const [app, identity] = process.argv.slice(2);
if (!app || !identity) {
  console.error('usage: node scripts/sign.mjs <Storm.app> <identity>');
  process.exit(2);
}
const helper = /\((Plugin|GPU|Renderer)\)\.app/;
await sign({
  app,
  identity,
  ignore: notCode,
  optionsForFile: (file) => (helper.test(file) ? null : { entitlements: ['com.apple.security.cs.allow-jit'] }),
});
