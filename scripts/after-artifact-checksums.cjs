// Emit SHA-256 checksums for every build artifact (electron-builder
// afterAllArtifactBuild).
//
// Why this exists: Krypto Mirror ships UNSIGNED, so Chrome/SmartScreen have no
// certificate to vouch for the download. The next best trust signal we can give
// is a published checksum: a user (or a reputation service) can verify the file
// they got is byte-for-byte the one we built, and that it has not been swapped
// for a trojaned copy on the way down. We write a SHA256SUMS.txt next to the
// installers in the standard `sha256  filename` format (the one `sha256sum -c`
// and `Get-FileHash` understand) and return it so electron-builder tracks it
// as a published artifact.
//
// Pure, local, no network. Written as CommonJS so electron-builder require()s
// it directly.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = async function afterAllArtifactBuild(result) {
  // result.artifactPaths: absolute paths to every artifact just built.
  // result.outDir: the release directory (fallback for where to write).
  const paths = Array.isArray(result?.artifactPaths) ? result.artifactPaths : [];
  // Checksum the real deliverables, not electron-builder's own sidecars
  // (.blockmap, latest*.yml) — those are derived and change per channel.
  const targets = paths.filter((p) => /\.(exe|dmg|zip|AppImage|deb|rpm|snap)$/i.test(p));
  if (targets.length === 0) return [];

  const outDir = result.outDir || path.dirname(targets[0]);
  const lines = targets
    .slice()
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
    .map((p) => `${sha256(p)}  ${path.basename(p)}`);

  const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, lines.join('\n') + '\n', 'utf8');
  console.log(`  checksums: wrote SHA256SUMS.txt for ${targets.length} artifact(s)`);
  for (const l of lines) console.log(`    ${l}`);

  // Returned paths are treated by electron-builder as additional artifacts.
  return [sumsPath];
};
