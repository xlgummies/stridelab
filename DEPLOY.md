# StrideLab — deploy guide

A small React app that reads your runs from Supabase, behind a login.
Your publishable key is already baked into src/supabase.js (it's safe to ship).

## A. Lock the data to your account (Supabase SQL editor — run once)
    drop policy if exists "runs readable" on public.runs;
    create policy "runs auth read" on public.runs
      for select to authenticated using (true);

## B. Create your login (Supabase dashboard)
1. Authentication -> Users -> Add user -> Create new user.
   Enter your email + a password, toggle "Auto Confirm User" ON.
2. Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up"
   (you can still log in; this just stops anyone else from registering).

## C. Put it online (no terminal needed)
1. Create a new empty repo on GitHub (e.g. "stridelab").
2. "Add file -> Upload files", drag in everything from this folder
   EXCEPT node_modules and dist. Commit.
3. vercel.com -> Add New -> Project -> import that repo.
   Vercel auto-detects Vite. Click Deploy. You get a URL.
4. Open the URL, sign in with the user from step B. Done.

## D. (Optional) Turn on the AI coach
The analytics work without it. To enable AI feedback:
- Get an API key at console.anthropic.com.
- In Vercel -> your project -> Settings -> Environment Variables,
  add ANTHROPIC_API_KEY = your key. Redeploy.
