import { describe, it, expect } from 'vitest';
import { JwtService } from '../../src/auth/jwt-service.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('JwtService', () => {
  describe('sign', () => {
    it('signs a token with userId, username, and role', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-123', 'alice', 'customer');

      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3); // JWT has 3 parts
    });

    it('uses customer as default role when not specified', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-456', 'bob');
      const payload = service.verify(token);

      expect(payload.userId).toBe('user-456');
      expect(payload.username).toBe('bob');
      expect(payload.role).toBe('customer');
    });

    it('embeds role in the signed payload', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });

      const adminToken = service.sign('admin-1', 'admin', 'admin');
      const internalToken = service.sign('internal-1', 'internal', 'internal');
      const customerToken = service.sign('customer-1', 'customer', 'customer');

      expect(service.verify(adminToken).role).toBe('admin');
      expect(service.verify(internalToken).role).toBe('internal');
      expect(service.verify(customerToken).role).toBe('customer');
    });
  });

  describe('verify', () => {
    it('decodes and validates a correctly signed token', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-789', 'alice', 'internal');
      const payload = service.verify(token);

      expect(payload.userId).toBe('user-789');
      expect(payload.username).toBe('alice');
      expect(payload.role).toBe('internal');
      expect(typeof payload.iat).toBe('number');
      expect(typeof payload.exp).toBe('number');
    });

    it('throws for a tampered token', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-123', 'alice', 'customer');

      // Tamper with the payload (last character of the signature)
      const tampered = token.slice(0, -5) + 'XXXXX';
      expect(() => service.verify(tampered)).toThrow();
    });

    it('throws for a token signed with a different secret', () => {
      const service1 = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const service2 = new JwtService({ jwtSecret: 'completely-different-secret-key-32chars!', jwtExpiresIn: '1h' });

      const token = service1.sign('user-123', 'alice', 'admin');
      expect(() => service2.verify(token)).toThrow();
    });
  });

  describe('decode', () => {
    it('decodes a token without verification (unsafe)', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-999', 'alice', 'customer');
      const payload = service.decode(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe('user-999');
      expect(payload!.username).toBe('alice');
      expect(payload!.role).toBe('customer');
    });

    it('returns null for an invalid token format', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      expect(service.decode('not-a-valid.jwt.token')).toBeNull();
    });

    it('returns null for an empty string', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      expect(service.decode('')).toBeNull();
    });
  });

  describe('isJwtPayload guard', () => {
    it('accepts a valid payload with role field', () => {
      const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '1h' });
      const token = service.sign('user-abc', 'alice', 'admin');
      const payload = service.verify(token);

      // payload IS a JwtPayload
      expect(payload.userId).toBe('user-abc');
      expect(payload.username).toBe('alice');
      expect(payload.role).toBe('admin');
    });
  });
});
