function invalidAuthentication(message) {
  const error = new Error(message);
  error.code = 'UNAUTHENTICATED';
  return error;
}

/**
 * Development-only identity adapter.
 *
 * Production deployments should inject an authenticator that derives actorId
 * from authenticated transport or credential state (for example mTLS, OIDC,
 * or HTTP Message Signatures) rather than trusting a caller-supplied identity.
 */
export async function developmentHeaderAuthenticator(req) {
  const value = req.headers['x-participant-id'];
  if (value === undefined) return null;
  if (Array.isArray(value)) throw invalidAuthentication('multiple participant identity headers are not allowed');
  const actorId = String(value).trim();
  if (!actorId) return null;
  return {
    actorId,
    assurance: {
      method: 'development-header',
      authenticated: false,
    },
  };
}
