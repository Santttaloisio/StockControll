import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { User } from '../../database/models/index.js';

const issuer = 'stockcontroll-api';
const audience = 'stockcontroll-web';
const accessTokenLifetimeSeconds = 30 * 60;
const dummyPasswordHash = bcrypt.hashSync(randomBytes(32).toString('hex'), 12);

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function jwtSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;

  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes.');
  }

  return new TextEncoder().encode(secret);
}

export function validateJwtConfiguration(): void {
  jwtSecret();
}

function parseCredentials(input: unknown): { email: string; password: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AuthenticationError('Request body must be an object.', 400, 'INVALID_INPUT');
  }

  const credentials = input as Record<string, unknown>;
  if (Object.keys(credentials).some((field) => !['email', 'password'].includes(field))) {
    throw new AuthenticationError('Unexpected login field.', 400, 'INVALID_INPUT');
  }

  if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
    throw new AuthenticationError('Email and password are required.', 400, 'INVALID_INPUT');
  }

  const email = credentials.email.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    credentials.password.length === 0 ||
    Buffer.byteLength(credentials.password, 'utf8') > 72
  ) {
    throw new AuthenticationError('Email or password is invalid.', 400, 'INVALID_INPUT');
  }

  return { email, password: credentials.password };
}

export async function createAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenLifetimeSeconds}s`)
    .sign(jwtSecret());
}

export async function verifyAccessToken(token: string): Promise<string> {
  const secret = jwtSecret();

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer,
      audience,
      requiredClaims: ['sub', 'iat', 'exp']
    });

    if (!payload.sub) {
      throw new AuthenticationError('Invalid access token.', 401, 'INVALID_TOKEN');
    }

    return payload.sub;
  } catch (error) {
    throw new AuthenticationError('Invalid or expired access token.', 401, 'INVALID_TOKEN');
  }
}

export async function login(input: unknown): Promise<{ accessToken: string }> {
  const credentials = parseCredentials(input);
  const user = await User.findOne({ where: { email: credentials.email } });
  const passwordMatches = await bcrypt.compare(
    credentials.password,
    user?.passwordHash ?? dummyPasswordHash
  );

  if (!user || !user.isActive || !passwordMatches) {
    throw new AuthenticationError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
  }

  return { accessToken: await createAccessToken(user.id) };
}
