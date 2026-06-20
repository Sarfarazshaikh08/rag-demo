# Free Demo Deployment

Best free target for this project: Render Web Service.

Public demo URL after custom domain setup:

```text
https://demo.solvagence.com/rag
```

Optional direct use-case links:

```text
https://demo.solvagence.com/rag?useCase=hr
https://demo.solvagence.com/rag?useCase=support
https://demo.solvagence.com/rag?useCase=sales
https://demo.solvagence.com/rag?useCase=client-delivery
```

## Why Render

- Runs a normal Node/Express server.
- Supports GitHub deploys.
- Can use `npm start`.
- Has a public HTTPS URL.
- Supports `/health` checks.

## Free Tier Tradeoffs

Render Free is good for demos, not production:

- The service spins down after inactivity.
- First request after sleep can take about a minute.
- Local filesystem changes are lost after restart/redeploy.
- Uploaded documents may disappear after restart unless you use external storage.

For a client demo, keep approved seed documents in `backend/data/*.txt` and use uploaded documents only during the live call.

## Deploy Steps

1. Push this repo to GitHub.
2. Create a Render account.
3. New > Web Service.
4. Connect the GitHub repo.
5. Render should detect `render.yaml`.
6. Add secret env vars manually when Render asks:

```bash
GEMINI_API_KEY=<your-key>
ADMIN_PASSWORD_HASH=<bcrypt-hash>
REVIEWER_PASSWORD_HASH=<bcrypt-hash>
VIEWER_PASSWORD_HASH=<bcrypt-hash>
```

Generate password hashes locally:

```bash
npm run password:hash -- StrongPassword123
```

## Custom Domain with Route53

1. In Render, open the Web Service.
2. Go to Settings > Custom Domains.
3. Add:

```text
demo.solvagence.com
```

4. Render will show a target hostname like:

```text
solvagence-rag-demo.onrender.com
```

5. In AWS Route53, open the hosted zone for `solvagence.com`.
6. Create a CNAME record:

```text
Name: demo
Type: CNAME
Value: <your-render-target>.onrender.com
TTL: 300
```

7. Wait for DNS and Render certificate verification.

## Demo Reset

Because free hosting has ephemeral storage, use this as a clean demo environment:

- Keep core demo knowledge in `backend/data/*.txt`.
- Avoid uploading sensitive client documents.
- If the app restarts, re-upload temporary docs during the demo.

## Better Free-ish Upgrade

When demos become frequent, move to:

- Render paid small instance or low-cost VPS.
- PostgreSQL for users/documents/audit.
- PostgreSQL + pgvector for real vector retrieval.
- S3-compatible storage for originals.
