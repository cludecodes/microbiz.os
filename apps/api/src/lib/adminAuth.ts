import type { ApiContext } from "./auth";
import { getSessionUser } from "./auth";

/**
 * The single super-admin gate. Every /api/admin route must call this on the
 * request itself; UI visibility is never authorization.
 */
export async function requireSuperAdmin(c: ApiContext) {
  const user = await getSessionUser(c);
  return user && user.is_super_admin === 1 ? user : null;
}
