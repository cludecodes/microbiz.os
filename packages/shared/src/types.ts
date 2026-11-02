/** Shared domain types between API and web apps. */

export type WorkspaceRole = "owner" | "admin" | "manager" | "member";

export interface UserView {
  id: string;
  email: string;
  name: string;
  locale: "en" | "ur";
  is_super_admin: boolean;
  created_at: string;
}

export interface MembershipView {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  currency: "PKR" | "USD";
  locale: "en" | "ur";
  plan_id: string;
  plan_name: string;
  subscription_status: "active" | "trialing" | "canceled" | "past_due";
  role: WorkspaceRole;
  created_at: string;
}

export interface AppView {
  id: string;
  name: string;
  description: string;
  phase: number;
  enabled: boolean;
}

export interface ApiError {
  error: string;
  detail?: string;
}
