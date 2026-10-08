# Accounts v1 — how Lee applies this

Nothing in this folder is applied to the live Supabase project by the pull request. There is no service-role key, no secret key, and no `sb_secret_` value in the repo. The site only ever ships the public project URL and the publishable key.

The delete-account function reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase runtime. Those are injected in the dashboard. Do not copy them into git, into `index.html`, or onto a laptop note in this repo.

Keep **Verify JWT** on for `delete-account`. That is the default, and `supabase/config.toml` sets `verify_jwt = true`.

## 1. Apply the migration

Either paste `supabase/migrations/0001_accounts_v1.sql` into the Supabase SQL editor, or from a machine you trust:

```bash
supabase link --project-ref iubuiipzegwlzqjoftpj
supabase db push
```

Then run the commented verification queries at the bottom of the migration. Every public table should show `relrowsecurity = true`, and `pg_policies` should list select, insert, update, and delete for `profiles`, `cars`, `inspections`, `photos`, and the `car-photos` bucket objects. There should be no policy for `anon` and no admin view.

## 2. Deploy the delete-account function

```bash
supabase functions deploy delete-account
```

The function checks the caller's JWT with `auth.getUser`. It does not accept a user id in the body. It deletes objects under `car-photos/<user id>/`, then deletes the auth user. Cars, inspections, photos rows, and the profile drop via `on delete cascade`.

Allowed browser origins are `https://996buyersguide.com` and `http://localhost:8000`.

## 3. Pre-launch checklist

Do these before anyone sets `ACCOUNTS_ENABLED` to `true` in `index.html`.

- Leave the Email provider **off** (Authentication → Sign In / Providers). Lee turned it off on 2026-10-08. Turning it on would let people create a session without the site flag.
- Keep "Allow new users to sign up" off in Supabase Auth settings until launch day.
- Google provider is **on**. Skip nonce check stays **off**.
- Google Cloud authorized JavaScript origin includes `https://996buyersguide.com`. For local checks, `http://localhost:8000` can be added too. The popup should show 996buyersguide.com / "996 Buyer's Guide".
- Site URL and redirect URLs in Supabase Auth point at `https://996buyersguide.com`.
- Lee has approved the privacy page and the terms page, both are merged and live, and the contact-email TODOs on those pages are filled with his existing email. The Supabase region on the privacy page is US West (Oregon).
- Then, and only with Lee's yes, flip `ACCOUNTS_ENABLED` to `true`.

Google Identity Services is loaded from `https://accounts.google.com/gsi/client`. Google does not publish a pinned version of that script. The Supabase browser library is pinned to `@supabase/supabase-js@2.117.3` with a subresource integrity hash.

Sign-up stays off on the public site until that flag is flipped. A local-only override is `http://localhost:8000/?accounts=1`. That override does not run on the live domain.

Google Identity Services and the Supabase browser library load only after someone taps Sign in, or when a stored Supabase session on this device needs restoring. A visitor who never taps Sign in does not request `accounts.google.com`, `cdn.jsdelivr.net`, or `supabase.co`.

## Photo rules (v1.1)

The photo screens are not in v1. The policies already require the car to belong to the uploader: `cars.user_id = auth.uid()` for the `car_id` on the photos row, and for the car id in the storage path (`{user id}/{car id}/{file}.jpg` in the private `car-photos` bucket). Keep those checks when the upload UI is added.
