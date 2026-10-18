import { cleanRelative } from './safety.js';

export const IDENTITY_READ_PROTECTION = 'Đọc hoặc tải identity của server cần quyền quản lý server.';

// Use the same normalized relative paths as the file manager. Matching exact
// segments avoids both keys-backup false positives and separator bypasses.
// ASCII case folding keeps the privacy policy consistent on Ubuntu and Windows.
export function isIdentityPath(input) {
  const relative = cleanRelative(input, { allowRoot: false });
  return relative.split('/').some(segment => {
    const name = segment.toLowerCase();
    return name === 'keys' || name === 'server_identity_key.pem';
  });
}
