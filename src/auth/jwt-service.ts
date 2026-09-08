import jwt, { type SignOptions } from 'jsonwebtoken';
import type { AuthConfig, JwtPayload, UserRole } from './types.js';

type JwtServiceConfig = Pick<AuthConfig, 'jwtSecret' | 'jwtExpiresIn'>;

export class JwtService {
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;

  constructor(config: JwtServiceConfig) {
    this.jwtSecret = config.jwtSecret;
    this.jwtExpiresIn = config.jwtExpiresIn;
  }

  sign(userId: string, username: string, role: UserRole = 'customer'): string {
    const options: SignOptions = {
      algorithm: 'HS256',
      expiresIn: this.jwtExpiresIn as SignOptions['expiresIn']
    };

    return jwt.sign({ userId, username, role }, this.jwtSecret, options);
  }

  verify(token: string): JwtPayload {
    const payload = jwt.verify(token, this.jwtSecret, {
      algorithms: ['HS256']
    });

    if (!isJwtPayload(payload)) {
      throw new Error('Invalid JWT payload');
    }

    return payload;
  }

  decode(token: string): JwtPayload | null {
    const payload = jwt.decode(token);
    return isJwtPayload(payload) ? payload : null;
  }
}

function isJwtPayload(value: unknown): value is JwtPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    'username' in value &&
    'role' in value &&
    'iat' in value &&
    'exp' in value &&
    typeof value.userId === 'string' &&
    typeof value.username === 'string' &&
    typeof value.role === 'string' &&
    typeof value.iat === 'number' &&
    typeof value.exp === 'number'
  );
}
