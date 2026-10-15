// "Continue with Google": verifies Google ID tokens from the Google Identity Services button.
// Enabled when GOOGLE_CLIENT_ID is set (create one at console.cloud.google.com > APIs & Services > Credentials).
const { OAuth2Client } = require('google-auth-library');

const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const enabled = !!clientId;
const client = enabled ? new OAuth2Client(clientId) : null;

/** Checks the token's signature, expiry, issuer and audience. Returns { sub, email, emailVerified, name }. */
async function defaultVerify(idToken) {
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const p = ticket.getPayload();
  return { sub: p.sub, email: p.email || null, emailVerified: !!p.email_verified, name: p.name || p.given_name || null };
}

let verifier = defaultVerify;

module.exports = {
  get enabled() { return enabled || verifier !== defaultVerify; },
  clientId,
  verify: (token) => verifier(token),
  /** Tests only: replace Google verification with a stub. */
  _setVerifier(fn) { verifier = fn || defaultVerify; },
};
