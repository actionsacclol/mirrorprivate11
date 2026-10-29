// Stand-in for the `electron` module so main-process modules can be unit
// tested off a real temp directory. KRYPT_TEST_USERDATA names that directory.
export const app = {
  getPath: (what) => {
    if (what !== 'userData') throw new Error(`stub: unexpected path ${what}`);
    const dir = process.env.KRYPT_TEST_USERDATA;
    if (!dir) throw new Error('stub: KRYPT_TEST_USERDATA is not set');
    return dir;
  },
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  isPackaged: false,
};
// Custom schemes (krypt-img, krypt-guide): registration is a no-op off Electron.
export const protocol = {
  registerSchemesAsPrivileged: () => undefined,
  handle: () => undefined,
};
// A reversible stand-in for OS encryption: the test cares about the file
// lifecycle, not the cipher.
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
};
export default { app, safeStorage, protocol };
