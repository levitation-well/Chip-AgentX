import type { ServerResponse } from 'node:http';
import type { AuthConfig, AuthenticatedRequest, JwtPayload } from './types.js';
import type { JwtService } from './jwt-service.js';
import type { UserStore } from './user-store.js';
import { getUserAvailability } from './user-governance.js';

export function extractBearerToken(req: AuthenticatedRequest): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function extractMcpBearerKey(req: AuthenticatedRequest): string | null {
  // Remote MCP intentionally accepts only the HTTP Authorization bearer header.
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function authenticateRequest(req: AuthenticatedRequest, jwtService: JwtService): JwtPayload {
  const token = extractBearerToken(req);
  if (!token) {
    throw new Error('Missing bearer token');
  }

  return jwtService.verify(token);
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: ServerResponse,
  jwtService: JwtService
): boolean {
  try {
    req.user = authenticateRequest(req, jwtService);
    return true;
  } catch {
    sendUnauthorized(res);
    return false;
  }
}

export async function authenticateUsableRequest(
  req: AuthenticatedRequest,
  jwtService: JwtService,
  userStore: UserStore
): Promise<JwtPayload> {
  const payload = authenticateRequest(req, jwtService);
  const user = await userStore.findById(payload.userId);
  if (!user || !getUserAvailability(user).usable) {
    throw new Error('User unavailable');
  }
  const publicUser = userStore.toPublicUser(user);

  return {
    ...payload,
    userId: user.id,
    username: user.username,
    role: user.role,
    authorizedModels: publicUser.authorizedModels,
    credits: publicUser.credits
  };
}

export async function requireUsableAuth(
  req: AuthenticatedRequest,
  res: ServerResponse,
  jwtService: JwtService,
  userStore: UserStore
): Promise<boolean> {
  try {
    req.user = await authenticateUsableRequest(req, jwtService, userStore);
    return true;
  } catch {
    sendUnauthorized(res);
    return false;
  }
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: ServerResponse,
  jwtService: JwtService,
  _config: AuthConfig
): boolean {
  if (!requireAuth(req, res, jwtService)) {
    return false;
  }

  if (req.user?.role !== 'admin') {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  }

  return true;
}

export async function requireUsableAdmin(
  req: AuthenticatedRequest,
  res: ServerResponse,
  jwtService: JwtService,
  userStore: UserStore
): Promise<boolean> {
  if (!(await requireUsableAuth(req, res, jwtService, userStore))) {
    return false;
  }

  if (req.user?.role !== 'admin') {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  }

  return true;
}

export function sendUnauthorized(res: ServerResponse, message = 'Unauthorized'): void {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}
