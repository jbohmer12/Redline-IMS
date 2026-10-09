# Deploying the bug-fix release

This release moves roles into the database and makes the Netlify functions check who is calling.
**Do the steps in this order**, or sign-in-protected features will stop working until you finish.

## 1. Netlify environment variables (Site configuration → Environment variables)

| Variable | Value | New? |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL (the same one in `index.html`) | **New** |
| `SUPABASE_ANON_KEY` | Your Supabase **anon** public key (the same one in `index.html`). Never the service-role key. | **New** |
| `EBAY_TOKEN_GEN_ENABLED` | Leave **unset**. Set to `true` only while you generate a new eBay refresh token, then delete it. | **New, optional** |
| `ANTHROPIC_WORKSPACE_ID` | Only if your Anthropic key isn't scoped to a workspace: the workspace ID from console.anthropic.com → Settings → Workspaces. Easier: create a workspace-scoped key instead. | **New, optional** |
| `ANTHROPIC_API_KEY`, `EBAY_PROD_CLIENT_ID`, `EBAY_PROD_CLIENT_SECRET`, `EBAY_PROD_RUNAME`, `EBAY_REFRESH_TOKEN` | Unchanged | — |

## 2. Supabase: run the migration

Supabase → SQL Editor → New query → paste `supabase/migrations/20261008_roles_and_rls.sql` → Run.
It copies everyone's current role into `app_metadata`, so nobody loses access. Then check:

```sql
select email, raw_app_meta_data->>'role' as role from auth.users order by email;
```

## 3. Deploy the site

Deploy the `polish` branch as usual.

## 4. Everyone signs out and back in once

Roles are read from the sign-in token, which picks up the new `app_metadata` on the next sign-in.
Until then, someone may briefly see the Data logger view.

## Rolling back

Redeploy the previous build. The migration can stay: the old app ignores `app_metadata`,
and the new policies only restrict deletes, prices, the activity log and photo uploads to admins.
