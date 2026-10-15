// electron-builder afterPack hook: signs the macOS app with the self-signed "Bongo Champs Signing" certificate.
//
// Why: macOS ties the Accessibility permission to the app's code signature. Ad-hoc signatures change on every
// build, so users lost the permission after each update. A fixed certificate gives a stable identity
// (identifier + certificate), so the permission survives updates.
// electron-builder refuses non-trusted (self-signed) identities, hence this hook instead of "mac.identity".
// Certificate setup and backup: see README > Signing.

const { execFileSync } = require('child_process');
const path = require('path');
const { Arch } = require('electron-builder');

const IDENTITY_NAME = process.env.BONGO_SIGN_IDENTITY || 'Bongo Champs Signing';

/** Returns the SHA-1 of the code-signing identity with this name (trusted or not), or null. */
function findIdentityHash(name) {
    const output = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    for (const line of output.split('\n')) {
        const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/.exec(line);
        if (match && match[2] === name) {
            return match[1];
        }
    }
    return null;
}

exports.default = async function signMac(context) {
    // Per-arch temporary builds are merged into the universal app afterwards: only sign the final one.
    if (context.electronPlatformName !== 'darwin' || context.arch !== Arch.universal) {
        return;
    }

    const hash = findIdentityHash(IDENTITY_NAME);
    if (!hash) {
        throw new Error(`Code-signing identity "${IDENTITY_NAME}" not found in the keychain. See README > Signing.`);
    }

    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', hash, appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`  • signed with "${IDENTITY_NAME}" (${hash})`);
};
