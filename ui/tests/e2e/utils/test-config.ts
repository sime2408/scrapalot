// Log in by USERNAME, not email: the admin account's email was merged to the
// owner's Gmail (Google login lands on the admin profile), so admin@test.com
// no longer resolves. The username "admin" is stable and decoupled from the
// email, so tests keep passing regardless of future email changes.
export const TEST_EMAIL = process.env.TEST_EMAIL || 'admin';
export const TEST_PASSWORD = process.env.TEST_PASSWORD || 'admin123';
